/** Private, read-only evaluation inputs. Never persist invoices or call a provider. */
import {
  allocatedCosts,
  normalizedReference,
  requireMetric,
  type CostAllocation,
  type ReferenceInput,
} from "../trading/metrics.js";
import { replayHash } from "./replay-dataset.js";

export interface EvaluationInput {
  schema_version: "btc.evaluation-input.v1";
  allocation?: CostAllocation;
  references?: (ReferenceInput & {
    source: string;
    fee_basis: string | null;
    funding_basis: string | null;
  })[];
}
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
function keys(x: unknown, allowed: string[]) {
  requireMetric(
    object(x) && Object.keys(x).every((k) => allowed.includes(k)),
    "EVALUATION_INPUT",
  );
}
const text = (x: unknown, max = 512) =>
  typeof x === "string" && x.trim().length > 0 && x.length <= max;
export function validateEvaluationInput(
  value: unknown,
): EvaluationInput | undefined {
  if (value === undefined) return undefined;
  keys(value, ["schema_version", "allocation", "references"]);
  const input = value as EvaluationInput;
  requireMetric(
    input.schema_version === "btc.evaluation-input.v1",
    "EVALUATION_VERSION",
  );
  if (input.allocation !== undefined) {
    const a = input.allocation;
    keys(a, ["schema_version", "window", "complete", "basis", "bills"]);
    keys(a.window, ["start", "end"]);
    requireMetric(Array.isArray(a.bills) && a.bills.length <= 64, "COST_LIMIT");
    for (const b of a.bills) {
      keys(b, ["id", "kind", "total_usd_raw", "shares"]);
      requireMetric(
        text(b.id, 160) && Array.isArray(b.shares) && b.shares.length <= 32,
        "BILL_ID_OR_KIND",
      );
      for (const s of b.shares) {
        keys(s, ["account_id", "usd_raw"]);
        requireMetric(text(s.account_id, 160), "COST_SHARE");
      }
    }
    allocatedCosts(a, "", a.window.start, a.window.end);
  }
  if (input.references !== undefined) {
    requireMetric(
      Array.isArray(input.references) && input.references.length <= 8,
      "REFERENCE_LIMIT",
    );
    const seen = new Set<string>();
    for (const r of input.references) {
      keys(r, [
        "kind",
        "exposure_bps",
        "capital_usd_raw",
        "window",
        "prices",
        "fees_usd_raw",
        "funding_usd_raw",
        "source",
        "fee_basis",
        "funding_basis",
      ]);
      keys(r.window, ["start", "end"]);
      requireMetric(
        text(r.source) &&
          (r.fees_usd_raw === null
            ? r.fee_basis === null
            : text(r.fee_basis)) &&
          (r.funding_usd_raw === null
            ? r.funding_basis === null
            : text(r.funding_basis)),
        "REFERENCE_SOURCE",
      );
      if (r.prices !== null) {
        keys(r.prices, ["start", "end"]);
        for (const p of [r.prices.start, r.prices.end]) {
          keys(p, ["at", "usd_raw", "evidence_id"]);
          requireMetric(text(p.evidence_id, 256), "REFERENCE_SOURCE");
        }
      }
      const key = `${r.kind}:${r.exposure_bps}`;
      requireMetric(!seen.has(key), "REFERENCE_DUPLICATE");
      seen.add(key);
      normalizedReference(r);
    }
  }
  return input;
}

export function evaluationContext(
  input: EvaluationInput | undefined,
  scope: { window: { start: string; end: string } },
  capital: string | null,
) {
  const supplied = input?.references ?? [];
  for (const r of supplied)
    requireMetric(
      r.window.start === scope.window.start &&
        r.window.end === scope.window.end &&
        r.capital_usd_raw === capital,
      "REFERENCE_WINDOW_OR_CAPITAL",
    );
  const defaults: NonNullable<EvaluationInput["references"]> =
    capital !== null && BigInt(capital) > 0n
      ? [
          {
            kind: "cash",
            exposure_bps: 0,
            capital_usd_raw: capital,
            window: scope.window,
            prices: null,
            fees_usd_raw: "0",
            funding_usd_raw: "0",
            source: "contractual_cash_no_interest",
            fee_basis: "no_transactions",
            funding_basis: "cash_has_no_funding",
          },
          {
            kind: "perpetual",
            exposure_bps: 2500,
            capital_usd_raw: capital,
            window: scope.window,
            prices: null,
            fees_usd_raw: null,
            funding_usd_raw: null,
            source: "hyperliquid_btc_perpetual_observations_missing",
            fee_basis: null,
            funding_basis: null,
          },
        ]
      : [];
  return {
    schema_version: "btc.evaluation-context.v1",
    input_hash: input ? replayHash(input) : null,
    allocation_hash: input?.allocation ? replayHash(input.allocation) : null,
    cost_status: input?.allocation
      ? "operator_attested_complete_not_audited"
      : "unknown",
    cost_basis: input?.allocation?.basis ?? null,
    references: [
      ...supplied,
      ...defaults.filter(
        (d) =>
          !supplied.some(
            (r) => r.kind === d.kind && r.exposure_bps === d.exposure_bps,
          ),
      ),
    ].map((r) => ({
      ...normalizedReference(r),
      missing: [
        ...(r.kind !== "cash" && r.prices === null ? ["endpoint_prices"] : []),
        ...(r.fees_usd_raw === null ? ["fees"] : []),
        ...(r.funding_usd_raw === null ? ["funding"] : []),
      ],
    })),
    reference_capital_status:
      capital !== null && BigInt(capital) > 0n
        ? "available"
        : "unknown_or_nonpositive",
    causal_contribution: null,
  };
}
