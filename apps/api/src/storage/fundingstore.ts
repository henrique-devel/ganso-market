import { withRecovery } from "./recoverystore.js";
import { observeRiskTx, readRiskTx } from "./riskstore.js";
import { createHash } from "node:crypto";
import {
  parseTradingAmount,
  tradingIdempotencyKey,
  type TradingScope,
  type TradingMarketData,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  FUNDING_HOUR_MS,
  FUNDING_VERSION,
  FUNDING_POLICY,
  PAPER_FUNDING_MODEL,
  PAPER_FUNDING_POLICY,
  PAPER_FUNDING_MAX_RECEIPT_AGE_MS,
  fundingDelta,
  fundingPositions,
  fundingCoverage,
  type FundingReceipt,
} from "../trading/funding.js";
import { contextSnapshotTime } from "../trading/valuation.js";
import type { LedgerReplayEvent } from "../trading/ledger.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { assertEvidenceJson } from "../trading/retention.js";
import {
  FUNDING_SOURCE,
  fundingHour,
  fundingTime,
  parseFinalFunding,
} from "../venues/hyperliquid/funding.js";
import {
  appendLedgerBatchTx,
  lockableLedgerAccountTx,
  readLedgerAccountTx,
} from "./ledgerstore.js";
import {
  materializeLedgerBatch,
  type LedgerCommand,
} from "./ledger-contract.js";
import {
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "./btc-retention.js";

export interface FundingCommand {
  model_version?: typeof PAPER_FUNDING_MODEL;
  operation_id: string;
  period_hour: string;
  observation: {
    source: typeof FUNDING_SOURCE;
    received_at: string;
    row: unknown;
  } | null;
  oracle_object_id: string | null;
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalFingerprint(v)).digest("hex");
function requireFunding(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_FUNDING_${code}`);
}
export async function readFundingReceiptsTx(
  tx: SqlExecutor,
  accountId: string,
) {
  return (
    await tx.query<{ result: FundingReceipt }>(
      "SELECT result FROM btc_funding_results WHERE account_id=$1 ORDER BY sequence",
      [accountId],
    )
  ).rows.map((r) => r.result);
}
export async function readFundingCoverageTx(
  tx: SqlExecutor,
  accountId: string,
  events: readonly LedgerReplayEvent[],
  asOf: string,
) {
  return fundingCoverage(
    events,
    await readFundingReceiptsTx(tx, accountId),
    asOf,
  );
}
/** Indexed, bounded selection. Receipt age is NOT price age. A later response
 * can never backfill a historical cutoff. Same receipt time uses object ID. */
export async function paperFundingOracleTx(
  tx: SqlExecutor,
  scope: TradingScope,
  cutoff: string,
) {
  const rows = (
    await tx.query<{ object_id: string; payload: TradingMarketData }>(
      `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
     WHERE r.kind='context' AND r.received_at <= $1 AND r.received_at >= $2
     ORDER BY r.received_at DESC,r.object_id LIMIT 16`,
      [
        cutoff,
        new Date(
          Date.parse(cutoff) - PAPER_FUNDING_MAX_RECEIPT_AGE_MS,
        ).toISOString(),
      ],
    )
  ).rows;
  return (
    rows.find(({ payload: o }) => validPaperOracle(o, scope, cutoff)) ?? null
  );
}
function validPaperOracle(
  o: TradingMarketData,
  scope: TradingScope,
  cutoff: string,
) {
  const p = o.payload;
  return (
    o.schema_version === "trading.market-data.v1" &&
    o.instrument_id === scope.instrument_id &&
    o.instrument_version === scope.instrument_version &&
    o.source_id === "hyperliquid:mainnet:info" &&
    o.parser_version === "hyperliquid.context-snapshot.v1" &&
    o.channel === "context" &&
    o.source_timestamp === null &&
    o.quality === "unknown" &&
    o.received_at <= cutoff &&
    Date.parse(cutoff) - Date.parse(o.received_at) <=
      PAPER_FUNDING_MAX_RECEIPT_AGE_MS &&
    p.kind === "mark_funding" &&
    !!contextSnapshotTime(p.snapshot, o.received_at)
  );
}
/** Paper reconciliation used by the manual desk consumer.
 * Lock order retention -> account matches broker. Everything, including pending
 * evidence/pins, commits atomically. Retry identity is operation_id; settlement
 * identity is owner/hour, with deterministic per-position ledger keys. */
export async function reconcileFunding(
  pool: Pick<DatabasePool, "transaction">,
  scopeInput: TradingScope,
  input: FundingCommand,
): Promise<FundingReceipt> {
  assertEvidenceJson(input);
  requireFunding(
    Object.keys(input).sort().join() ===
      (input.model_version === undefined
        ? "observation,operation_id,oracle_object_id,period_hour"
        : "model_version,observation,operation_id,oracle_object_id,period_hour") &&
      (input.model_version === undefined ||
        input.model_version === PAPER_FUNDING_MODEL) &&
      /^[a-zA-Z0-9:._-]{1,160}$/.test(input.operation_id) &&
      (input.oracle_object_id === null ||
        (typeof input.oracle_object_id === "string" &&
          input.oracle_object_id.length <= 200)) &&
      canonicalFingerprint(input).length < 8192,
    "COMMAND",
  );
  const hour = fundingHour(input.period_hour);
  const paper = input.model_version === PAPER_FUNDING_MODEL;
  const rateDecimals = paper ? 18 : 9;
  if (input.observation) {
    requireFunding(
      Object.keys(input.observation).sort().join() ===
        "received_at,row,source" && input.observation.source === FUNDING_SOURCE,
      "SOURCE",
    );
    parseFinalFunding(
      input.observation.row,
      input.period_hour,
      input.observation.received_at,
      rateDecimals,
    );
  }
  const request: FundingCommand = JSON.parse(JSON.stringify(input)),
    scope = { ...scopeInput };
  return withRecovery(
    pool,
    scope,
    true,
  )(async (tx) => {
    const identity = await lockableLedgerAccountTx(tx, scope, true);
    const now = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString();
    requireFunding(
      hour <= fundingTime(now) &&
        (!request.observation || request.observation.received_at <= now),
      "FUTURE",
    );
    const prior = (
      await tx.query(
        "SELECT request,result FROM btc_funding_results WHERE account_id=$1 AND operation_id=$2",
        [scope.account_id, request.operation_id],
      )
    ).rows[0];
    if (prior) {
      requireFunding(
        canonicalFingerprint(prior.request) === canonicalFingerprint(request),
        "IDEMPOTENCY_COLLISION",
      );
      return prior.result as FundingReceipt;
    }
    const ledger = await readLedgerAccountTx(tx, scope);
    const rows = (await readFundingReceiptsTx(tx, scope.account_id)).filter(
      (r) => r.period_hour === request.period_hour,
    );
    const final = request.observation
      ? parseFinalFunding(
          request.observation.row,
          request.period_hour,
          request.observation.received_at,
          rateDecimals,
        )
      : null;
    // Preserve legacy observation identity across an explicit model upgrade.
    const legacyFinal = request.observation
      ? parseFinalFunding(
          request.observation.row,
          request.period_hour,
          request.observation.received_at,
        )
      : null;
    const basis = legacyFinal
      ? hash([
          legacyFinal.cutoff,
          legacyFinal.rate_raw ?? request.observation!.row,
        ])
      : null;
    const evidenceId = `btc-funding:${hash([scope, request.operation_id])}`;
    const result: FundingReceipt = {
      schema_version: FUNDING_VERSION,
      ...(paper
        ? {
            model_version: PAPER_FUNDING_MODEL,
            rate:
              final?.rate_raw === null || !final
                ? null
                : {
                    unit: "RATE" as const,
                    decimals: 18 as const,
                    raw: final.rate_raw,
                  },
            price_evidence: null,
          }
        : {}),
      period_hour: request.period_hour,
      cutoff: final?.cutoff ?? null,
      status: "pending",
      reason: "missing_final_rate",
      basis,
      oracle_usd_raw: null,
      positions: [],
      evidence_id: evidenceId,
    };
    const deps: string[] = [];
    let oracle: TradingMarketData | null = null;
    if (request.oracle_object_id) {
      const stored = (
        await tx.query(
          "SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.object_id=$1 AND r.kind='context'",
          [request.oracle_object_id],
        )
      ).rows[0];
      requireFunding(!!stored, "ORACLE_NOT_FOUND");
      oracle = stored.payload as TradingMarketData;
      deps.push(request.oracle_object_id);
    }
    const settled = rows.find((r) => r.status === "settled");
    if (
      rows.some((r) => r.status === "conflict") ||
      (basis !== null &&
        rows.some((r) => r.basis !== null && r.basis !== basis))
    ) {
      result.status = "conflict";
      result.reason = "divergent_final_observation";
    } else if (final) {
      const eligible = fundingPositions(ledger.events, final.cutoff);
      if (eligible.ambiguous.length) result.reason = "ambiguous_cutoff_order";
      else if (final.rate_raw === null) result.reason = final.precision;
      else {
        const p = oracle?.payload;
        // Source time must be the actual settlement cut, not receipt time, a
        // nearby current context, candle, mark, premium or inferred oracle.
        const exactOracle =
          oracle?.schema_version === "trading.market-data.v1" &&
          oracle.instrument_id === scope.instrument_id &&
          oracle.instrument_version === scope.instrument_version &&
          oracle.source_id === "hyperliquid:mainnet:ws" &&
          oracle.parser_version === "hyperliquid.feed.v1" &&
          oracle.channel === "context" &&
          oracle.quality === "fresh" &&
          oracle.source_timestamp === final.cutoff &&
          oracle.received_at >= final.cutoff &&
          oracle.received_at <= now &&
          p?.kind === "mark_funding";
        const validOracle = paper
          ? !!oracle && validPaperOracle(oracle, scope, final.cutoff)
          : exactOracle;
        if (eligible.positions.length && !validOracle)
          result.reason = paper
            ? "missing_pre_cut_snapshot"
            : "missing_settlement_oracle";
        else {
          const price =
            validOracle && p?.kind === "mark_funding"
              ? parseTradingAmount("USD_PER_BTC", p.oracle_price).raw
              : "0";
          requireFunding(
            !eligible.positions.length || BigInt(price) > 0n,
            "ORACLE_PRICE",
          );
          if (paper && eligible.positions.length && oracle) {
            // The consumer cannot choose a convenient older or future price.
            const selected = await paperFundingOracleTx(
              tx,
              scope,
              final.cutoff,
            );
            requireFunding(
              selected?.object_id === request.oracle_object_id,
              "PAPER_SELECTION_CHANGED",
            );
            result.price_evidence = {
              object_id: request.oracle_object_id!,
              received_at: oracle.received_at,
              receipt_age_ms:
                Date.parse(final.cutoff) - Date.parse(oracle.received_at),
              source_timestamp: null,
              quality: "unknown",
              fidelity: "paper_approximation_not_venue_settlement",
            };
          }
          result.oracle_usd_raw = eligible.positions.length ? price : null;
          result.positions = eligible.positions.map((position) => ({
            ...position,
            delta_usd_raw: fundingDelta(
              position.quantity_btc_raw,
              price,
              final.rate_raw!,
              rateDecimals,
            ),
          }));
          if (settled) {
            if (
              (eligible.positions.length > 0 &&
                (settled.model_version !== result.model_version ||
                  canonicalFingerprint(settled.price_evidence ?? null) !==
                    canonicalFingerprint(result.price_evidence ?? null))) ||
              settled.oracle_usd_raw !== result.oracle_usd_raw ||
              canonicalFingerprint(settled.positions) !==
                canonicalFingerprint(result.positions)
            ) {
              result.status = "conflict";
              result.reason = "divergent_settlement_basis";
            } else {
              result.status = "duplicate";
              result.reason = "already_settled";
            }
          } else {
            result.status = "settled";
            result.reason = eligible.positions.length
              ? paper
                ? "paper_pre_cut_snapshot"
                : "observed"
              : "no_eligible_position";
            const commands: LedgerCommand[] = result.positions.map(
              (position) => {
                const eventId = `funding:${hash([request.period_hour, position.position_id])}`;
                // Validate full trading.v1 units/ownership/origin at the adapter boundary.
                return {
                  schema_version: "trading.v1",
                  ...scope,
                  event_id: eventId,
                  idempotency_key: tradingIdempotencyKey(
                    scope,
                    "ledger",
                    eventId,
                  ),
                  cause_id: evidenceId,
                  occurred_at: final.cutoff,
                  payload: {
                    event_type: "funding",
                    position_id: position.position_id,
                    period_start: new Date(
                      hour - FUNDING_HOUR_MS,
                    ).toISOString(),
                    period_end: final.cutoff,
                    rate: {
                      unit: "RATE",
                      decimals: rateDecimals,
                      raw: final.rate_raw!,
                    },
                    delta: {
                      unit: "USD",
                      decimals: 6,
                      raw: position.delta_usd_raw,
                    },
                    origin: {
                      schema_version: "trading.v1",
                      instrument_id: scope.instrument_id,
                      instrument_version: scope.instrument_version,
                      source_id: FUNDING_SOURCE,
                      source_event_id: `BTC:${final.cutoff}`,
                      kind: "funding",
                      source_timestamp: final.cutoff,
                      received_at: request.observation!.received_at,
                      parser_version: paper
                        ? PAPER_FUNDING_MODEL
                        : FUNDING_VERSION,
                      payload_hash: hash(request.observation!.row),
                      quality: "fresh",
                    },
                  },
                } as LedgerCommand;
              },
            );
            if (commands.length) {
              requireFunding(commands.length <= 128, "POSITION_LIMIT");
              const batch = {
                transaction_id: `funding:${hash(request.period_hour)}`,
                events: commands,
              };
              materializeLedgerBatch(
                batch,
                ledger.projection.last_sequence,
                now,
              );
              await appendLedgerBatchTx(tx, identity, batch, now, false, true);
            }
          }
        }
      }
    }
    // An incomplete retry cannot erase an earlier settlement or conflict.
    if (settled && result.status === "pending") {
      delete result.model_version;
      delete result.rate;
      delete result.price_evidence;
      Object.assign(result, settled, {
        status: "duplicate",
        reason: "already_settled",
        evidence_id: evidenceId,
      });
    }
    await storeRetentionObjectTx(tx, {
      id: evidenceId,
      class: "financial",
      identity: scope,
      recordedAt: new Date(now),
      payload: {
        request,
        result,
        policy: paper ? PAPER_FUNDING_POLICY : FUNDING_POLICY,
        ledger_sequence: ledger.projection.last_sequence,
      },
      dependencies: deps,
    });
    await pinRetentionObjectTx(
      tx,
      evidenceId,
      evidenceId,
      "paper funding final rate, oracle and economic eligibility",
    );
    await tx.query(
      `INSERT INTO btc_funding_results(account_id,operation_id,sequence,period_hour,cutoff,status,request,result,evidence_id)
      SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,$4,$5,$6::jsonb,$7::jsonb,$8 FROM btc_funding_results WHERE account_id=$1`,
      [
        scope.account_id,
        request.operation_id,
        request.period_hour,
        result.cutoff,
        result.status,
        JSON.stringify(request),
        JSON.stringify(result),
        evidenceId,
      ],
    );
    if (await readRiskTx(tx, scope.account_id)) await observeRiskTx(tx, scope);
    return result;
  });
}
