import { createHash } from "node:crypto";
import type {
  TradingInstrumentMetadata,
  TradingMarketData,
  TradingScope,
} from "@ganso-market/contracts/trading";
import {
  barWarmup,
  BAR_BUILD_VERSION,
  type ClosedBar,
  type BarInterval,
} from "../trading/bars.js";
import {
  type FinancialProjection,
  type ValuationCapture,
  valueFinancials,
} from "../trading/valuation.js";
import { type RiskCheckpoint } from "../trading/risk.js";
import type { Reservation } from "../trading/reservations.js";
import type { FundingReceipt } from "../trading/funding.js";
import { BASELINE_POLICY } from "../trading/strategies/baseline.js";
import {
  BASELINE_FINGERPRINT,
  canonicalBaselineJson,
} from "./baseline-manifest.js";

export const baselineHash = (v: unknown) =>
  createHash("sha256").update(canonicalBaselineJson(v)).digest("hex");
export const baselineTime = (s: string) => {
  const n = Date.parse(s);
  if (!Number.isSafeInteger(n) || n < 0 || new Date(n).toISOString() !== s)
    throw new TypeError("BTC_BASELINE_TIME");
  return n;
};
export const baselineIso = (n: number) => new Date(n).toISOString();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Retention hash is over the canonical payload, never over mutable receipt time.
 * The future store must select these records as-of, pin references atomically,
 * and call under the existing retention/account lock. No public caller input. */
export interface BaselineRef {
  object_id: string;
  payload_hash: string;
  recorded_at: string;
}
export interface BaselineRecord<T> extends BaselineRef {
  payload: T;
}
export interface BaselineRegistration {
  scope: TradingScope;
  policy_version: typeof BASELINE_POLICY;
  manifest_fingerprint: typeof BASELINE_FINGERPRINT;
  code_sha: string;
  metadata_hash: string;
  registered_at: string;
  start_at: string;
}
export interface BaselineAccount {
  projection: FinancialProjection;
  risk: RiskCheckpoint;
  reservations: Reservation[];
  /** Outputs of the existing funding/recovery/accounting guards, never flags
   * supplied by a user or inferred from the presence of credentials. */
  funding_usable_for_risk: boolean;
  recovery_ready: boolean;
  accounting_consistent: boolean;
  entries_paused: boolean;
  hold: boolean;
  exit_pending: boolean;
  last_closed_bar_end_at: string | null;
}
export interface BaselineMarket {
  book: BaselineRecord<TradingMarketData> | null;
  context: BaselineRecord<TradingMarketData> | null;
  capture: BaselineRecord<ValuationCapture> | null;
}
export interface BaselineEnvironment {
  enabled: boolean;
  registration: BaselineRegistration;
  metadata: BaselineRecord<TradingInstrumentMetadata> | null;
  account: BaselineRecord<BaselineAccount>;
  market: BaselineMarket;
  funding: BaselineRecord<FundingReceipt>[];
}
export interface BaselineBars {
  records: BaselineRecord<ClosedBar>[];
  /** First complete interval of the original observed history. Never move it
   * on truncation/restart: absent earlier bars must remain unavailable. */
  first_complete_start_at: string | null;
  /** Retained trade/capture dependencies, with original receipt times. */
  dependencies: (BaselineRef & { received_at: string })[];
}

export function validateBaselineRegistration(r: BaselineRegistration) {
  const registered = baselineTime(r.registered_at),
    start = baselineTime(r.start_at);
  if (
    r.scope.mode !== "paper" ||
    r.scope.instrument_id !== "hyperliquid:mainnet:BTC" ||
    !r.scope.account_id ||
    !r.scope.experiment_id ||
    !r.scope.instrument_version ||
    r.policy_version !== BASELINE_POLICY ||
    r.manifest_fingerprint !== BASELINE_FINGERPRINT ||
    !/^[a-f0-9]{40}$/.test(r.code_sha) ||
    !/^[a-f0-9]{64}$/.test(r.metadata_hash) ||
    start !== (Math.floor(registered / 900000) + 1) * 900000
  )
    throw new TypeError("BTC_BASELINE_REGISTRATION");
}
export function knownRecord<T>(
  r: BaselineRecord<T> | null,
  at: number,
): r is BaselineRecord<T> {
  if (!r) return false;
  try {
    return (
      !!r.object_id &&
      r.object_id.length <= 512 &&
      /^[a-f0-9]{64}$/.test(r.payload_hash) &&
      baselineTime(r.recorded_at) <= at &&
      baselineHash(r.payload) === r.payload_hash
    );
  } catch {
    return false;
  }
}
export function baselineRefs(
  records: readonly (BaselineRef | null)[],
): BaselineRef[] {
  const byId = new Map<string, BaselineRef>();
  for (const r of records)
    if (r) {
      const ref = {
        object_id: r.object_id,
        payload_hash: r.payload_hash,
        recorded_at: r.recorded_at,
      };
      const previous = byId.get(ref.object_id);
      if (
        previous &&
        canonicalBaselineJson(previous) !== canonicalBaselineJson(ref)
      )
        throw new Error("BTC_BASELINE_INPUT_COLLISION");
      byId.set(ref.object_id, ref);
    }
  return [...byId.values()].sort((a, b) =>
    a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0,
  );
}

/** Ignore future/late revisions; among known revisions choose first persisted
 * (recorded_at ASC, object_id ASC). Never fall back from a known invalid bar. */
export function baselineBars(
  input: BaselineBars,
  interval: BarInterval,
  required: number,
  end: number,
  at: number,
  version: string,
) {
  const chosen = [...input.records]
    .filter((r) => {
      try {
        return (
          baselineTime(r.recorded_at) <= at &&
          baselineTime(r.payload.end_at) <= end
        );
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) =>
        compare(b.payload.end_at, a.payload.end_at) ||
        compare(a.recorded_at, b.recorded_at) ||
        compare(a.object_id, b.object_id),
    );
  const unique = chosen
    .filter(
      (r, i) =>
        !chosen.slice(0, i).some((p) => p.payload.end_at === r.payload.end_at),
    )
    .slice(0, required);
  const refs: BaselineRef[] = [...unique];
  let invalid = false;
  for (const r of unique) {
    const b = r.payload;
    try {
      const start = baselineTime(b.start_at),
        stop = baselineTime(b.end_at),
        closed = baselineTime(b.closed_at);
      const o = b.ohlc,
        prices = o ? [o.open, o.high, o.low, o.close] : [];
      if (
        !knownRecord(r, at) ||
        b.schema_version !== "trading.closed-bar.v1" ||
        b.build_version !== BAR_BUILD_VERSION ||
        b.instrument_id !== "hyperliquid:mainnet:BTC" ||
        b.instrument_version !== version ||
        b.source_id !== "hyperliquid:mainnet:ws" ||
        b.interval_ms !== interval ||
        start % interval !== 0 ||
        stop !== start + interval ||
        closed < stop + 10000 ||
        closed > at ||
        baselineTime(r.recorded_at) < closed ||
        b.quality.state !== "observed_no_known_gap" ||
        b.quality.reasons.length !== 0 ||
        b.quality.continuity !== "unproven" ||
        !o ||
        o.unit !== "USD_PER_BTC" ||
        o.decimals !== 6 ||
        !prices.every((p) => /^[1-9][0-9]{0,37}$/.test(p)) ||
        BigInt(o.high) < BigInt(o.low) ||
        [o.open, o.close].some(
          (p) => BigInt(p) < BigInt(o.low) || BigInt(p) > BigInt(o.high),
        ) ||
        !Number.isSafeInteger(b.trade_count) ||
        b.trade_count <= 0 ||
        b.volume.unit !== "BTC" ||
        b.volume.decimals !== 8 ||
        !/^[1-9][0-9]{0,37}$/.test(b.volume.raw) ||
        b.input_ids.length === 0 ||
        new Set(b.input_ids).size !== b.input_ids.length
      )
        invalid = true;
      for (const id of b.input_ids) {
        const ds = input.dependencies.filter((d) => d.object_id === id);
        const d = ds[0];
        if (
          ds.length !== 1 ||
          !d ||
          !/^[a-f0-9]{64}$/.test(d.payload_hash) ||
          baselineTime(d.received_at) > closed ||
          baselineTime(d.recorded_at) > closed
        )
          invalid = true;
        if (d) refs.push(d);
      }
    } catch {
      invalid = true;
    }
  }
  // barWarmup derives the end from asOf; bind it to the requested decision T.
  const warm = barWarmup(
    unique.map((r) => r.payload),
    required,
    end + 10000,
    interval,
  );
  let state: "ready" | "warmup" | "data_unavailable" = "ready";
  if (
    !unique.length ||
    invalid ||
    warm.reason === "incomplete_or_discontinuous"
  )
    state = "data_unavailable";
  else if (!warm.ready) {
    state =
      input.first_complete_start_at === unique.at(-1)!.payload.start_at
        ? "warmup"
        : "data_unavailable";
  }
  return {
    state,
    bars: unique.map((r) => r.payload),
    refs: baselineRefs(refs),
  };
}

/** Compose the existing valuation, metadata and funding contracts. Does not
 * recompute equity from cash or subtract reservations from equity. */
export function baselineEnvironment(e: BaselineEnvironment, at: number) {
  const causes: string[] = [],
    refs: BaselineRef[] = [];
  const accountKnown = knownRecord(e.account, at);
  if (!accountKnown) throw new TypeError("BTC_BASELINE_ACCOUNT_EVIDENCE");
  refs.push(e.account);
  const a = e.account.payload,
    r = e.registration,
    now = baselineIso(at);
  if (
    canonicalBaselineJson(a.projection.ledger.scope) !==
    canonicalBaselineJson(r.scope)
  )
    throw new TypeError("BTC_BASELINE_SCOPE");
  const metadataRecord = knownRecord(e.metadata, at) ? e.metadata : null;
  const metadata = metadataRecord?.payload ?? null;
  if (metadataRecord) refs.push(metadataRecord);
  if (
    !metadata ||
    e.metadata!.payload_hash !== r.metadata_hash ||
    metadata.schema_version !== "trading.instrument-metadata.v1" ||
    metadata.instrument.instrument_version !== r.scope.instrument_version ||
    metadata.instrument.instrument_id !== r.scope.instrument_id ||
    baselineTime(metadata.instrument.origin.received_at) > at ||
    metadata.fees.taker.raw !== "450000" ||
    metadata.fees.taker.unit !== "RATE" ||
    metadata.fees.taker.decimals !== 9 ||
    metadata.fees.basis !== "public_base_tier_no_discounts" ||
    metadata.fees.account_effective !== null ||
    metadata.provenance.reference_version !==
      "hyperliquid-mainnet-btc.2026-09-23.1"
  )
    causes.push("metadata_unavailable");
  const book = knownRecord(e.market.book, at) ? e.market.book : null;
  const context = knownRecord(e.market.context, at) ? e.market.context : null;
  const capture = knownRecord(e.market.capture, at) ? e.market.capture : null;
  refs.push(...[book, context, capture].filter((x) => x !== null));
  const finance = valueFinancials(a.projection, {
    as_of: now,
    book,
    context,
    capture: capture?.payload ?? null,
  });
  if (finance.closing.quality !== "fresh" || !book)
    causes.push("book_unavailable");
  if (
    !finance.maintenance.usable_for_risk ||
    !context ||
    context.payload.parser_version !== "hyperliquid.context-snapshot.v1"
  )
    causes.push("context_unavailable");
  if (
    a.risk.version !== "btc.risk.v1" ||
    a.risk.observed_at !== now ||
    a.risk.ledger_sequence !== a.projection.ledger.last_sequence ||
    a.risk.equity_usd_raw !== finance.maintenance.equity_usd_raw ||
    a.projection.schema_version !== "btc.valuation.v1"
  )
    causes.push("account_snapshot_unavailable");
  if (!a.recovery_ready) causes.push("recovery_unavailable");
  const receipts = e.funding.filter((f) => knownRecord(f, at));
  refs.push(...receipts);
  const hour = baselineIso(Math.floor(at / 3600000) * 3600000);
  const current = receipts
    .filter((f) => f.payload.period_hour === hour)
    .sort(
      (a, b) =>
        compare(b.payload.cutoff ?? "", a.payload.cutoff ?? "") ||
        compare(b.recorded_at, a.recorded_at) ||
        compare(a.object_id, b.object_id),
    );
  const funding = current[0]?.payload;
  const rate = funding?.rate;
  let rateRaw: bigint | null = null;
  if (
    a.funding_usable_for_risk &&
    funding?.schema_version === "btc.funding.v1" &&
    funding.model_version === "btc.funding.paper-precut.v2" &&
    funding.status === "settled" &&
    funding.cutoff &&
    baselineTime(funding.cutoff) <= at &&
    funding.cutoff <= current[0]!.recorded_at &&
    funding.cutoff >= hour &&
    rate?.unit === "RATE" &&
    rate.decimals === 18 &&
    /^(0|-?[1-9][0-9]{0,16})$/.test(rate.raw) &&
    !current.some((f) => f.payload.status === "conflict")
  ) {
    const v = BigInt(rate.raw),
      magnitude = v < 0n ? -v : v;
    if (magnitude <= 40000000000000000n)
      rateRaw = magnitude > 100000000000000n ? magnitude : 100000000000000n;
  }
  if (rateRaw === null) causes.push("funding_unavailable");
  return {
    causes,
    refs: baselineRefs(refs),
    metadata,
    finance,
    rate: rateRaw,
    book,
    account: a,
  };
}
