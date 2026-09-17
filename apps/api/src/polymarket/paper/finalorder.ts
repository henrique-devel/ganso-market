// EXEC-02: one economic contract for normalized entry orders. No clock, expiry,
// sizing or fill policy lives here. All economics delegate to EXEC-01.
import { createHash } from "node:crypto";
import { formatScaled, parseScaled } from "../fundamental/fixed.js";
import {
  bookWalk,
  clearsEntryCriterion,
  computeExecutionEv,
} from "../portfolio/ev.js";
import type { PriceLevel } from "../types.js";
import type { NormalizedOrder } from "./validator.js";

export interface EntryEconomics {
  readonly accountId: string;
  readonly strategyId: string;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly marketSide: "YES" | "NO";
  readonly sizeMax: string;
  readonly q: string;
  readonly qLo: string;
  readonly qHi: string;
  readonly expectedLockupS: number;
  readonly capitalAnnualRate: string;
  readonly bufferDailyHurdle: string;
  readonly resolutionBuffer: string;
  readonly safetyMarginMin: string;
  readonly safetyMarginEdgeFraction: string;
  readonly edgeLiqMin: string;
  readonly modelRef: string;
  // Explicit conditional-on-fill assumptions, never a rebate or fill promise.
  readonly makerFee: string;
  readonly makerAdverseSelection: string;
  readonly makerAssumptionRef: string;
}

export interface FinalBook {
  readonly tokenId: string;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly sourceTs: string | null;
  readonly receivedAt: string;
}

export interface FinalFee {
  readonly rate: string | null;
  readonly paramVersionId: number | null;
  readonly sourceTs: string | null;
  readonly receivedAt: string | null;
  readonly validFrom: string | null;
}

export interface FinalOrderInput {
  readonly order: NormalizedOrder;
  readonly conditionId: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly economics: EntryEconomics;
  readonly book: FinalBook | null;
  readonly fee: FinalFee;
  readonly evaluatedAt: string;
}

export interface FinalOrderEvaluation {
  readonly ok: boolean;
  readonly reason: string;
  readonly evidence: Record<string, unknown>;
}

export function evaluateFinalEntry(
  input: FinalOrderInput,
): FinalOrderEvaluation {
  const evaluationId = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const evidence: Record<string, unknown> = {
    version: "final-entry-v1",
    evaluation_id: evaluationId,
    ...input,
    fee_source: "polymarket_param_versions",
    fee_age_ms:
      input.fee.receivedAt === null
        ? null
        : Date.parse(input.evaluatedAt) - Date.parse(input.fee.receivedAt),
  };
  const result = (reason: string): FinalOrderEvaluation => ({
    ok: reason === "FINAL_ENTRY_ACCEPTED",
    reason,
    evidence: { ...evidence, reason },
  });
  const e = input.economics;
  const o = input.order;
  if (
    input.accountId !== e.accountId ||
    input.strategyId !== e.strategyId ||
    input.conditionId !== e.conditionId ||
    o.tokenId !== e.tokenId ||
    o.side !== "BUY"
  )
    return result("FINAL_ENTRY_IDENTITY_MISMATCH");
  const size = parseScaled(o.size);
  const max = parseScaled(e.sizeMax);
  if (size === null || max === null || size <= 0n || size > max)
    return result("FINAL_ENTRY_SIZE_MISMATCH");
  if (input.book === null || input.book.tokenId !== o.tokenId)
    return result("FINAL_ENTRY_BOOK_MISSING");
  const bid = parseScaled(input.book.bids[0]?.price ?? "");
  const ask = parseScaled(input.book.asks[0]?.price ?? "");
  if (bid === null || ask === null || bid <= 0n || bid >= ask)
    return result("INVALID_BUY_WALK");
  let previous = 0n;
  for (const level of input.book.asks) {
    const price = parseScaled(level.price);
    if (price === null || price < previous) return result("INVALID_BUY_WALK");
    previous = price;
  }
  const walk = bookWalk(input.book.asks, size);
  if (walk === null) return result("INVALID_BUY_WALK");
  evidence["walk"] = Object.fromEntries(
    Object.entries(walk).map(([key, value]) => [
      key,
      typeof value === "bigint" ? formatScaled(value, 9) : value,
    ]),
  );
  if (!walk.complete) return result("BOOK_WALK_INCOMPLETE");
  const maker = o.postOnly && (o.orderType === "GTC" || o.orderType === "GTD");
  if (!maker && o.orderType !== "FAK" && o.orderType !== "FOK")
    return result("FINAL_ENTRY_UNSUPPORTED_TYPE");
  const limit = parseScaled(o.limitPrice);
  const worst = parseScaled(o.worstPrice ?? o.limitPrice);
  if (limit === null || worst === null || (!maker && walk.worstScaled > worst))
    return result("FINAL_ENTRY_PRICE_BOUND");
  if (
    !maker &&
    (input.fee.paramVersionId === null ||
      !Number.isSafeInteger(input.fee.paramVersionId) ||
      input.fee.paramVersionId <= 0 ||
      input.fee.receivedAt === null ||
      input.fee.validFrom === null ||
      input.fee.rate === null ||
      !Number.isFinite(Date.parse(input.fee.receivedAt ?? "")) ||
      !Number.isFinite(Date.parse(input.fee.validFrom ?? "")))
  )
    return result("TAKER_FEE_UNVERIFIED");
  const keys = [
    "q",
    "qLo",
    "qHi",
    "capitalAnnualRate",
    "bufferDailyHurdle",
    "resolutionBuffer",
    "safetyMarginMin",
    "safetyMarginEdgeFraction",
    "edgeLiqMin",
    "makerFee",
    "makerAdverseSelection",
  ] as const;
  const values = keys.map((key) => parseScaled(e[key]));
  if (
    values.some((value) => value === null) ||
    !e.modelRef ||
    !e.makerAssumptionRef
  )
    return result("FINAL_ENTRY_INPUT_MISSING");
  const [
    q,
    qLo,
    qHi,
    capital,
    hurdle,
    buffer,
    margin,
    fraction,
    minEdge,
    makerFee,
    adverse,
  ] = values as bigint[];
  if (minEdge! < 0n) return result("INVALID_EV_INPUT");
  const ev = computeExecutionEv({
    side: e.marketSide,
    qScaled: q!,
    qLoScaled: qLo!,
    qHiScaled: qHi!,
    walk,
    takerFeeRateScaled:
      input.fee.rate === null ? null : parseScaled(input.fee.rate),
    maker,
    makerLimitPriceScaled: limit,
    makerFeeScaled: makerFee!,
    makerAdverseSelectionScaled: adverse!,
    expectedLockupS: e.expectedLockupS,
    capitalAnnualRateScaled: capital!,
    bufferDailyHurdleScaled: hurdle!,
    resolutionBufferScaled: buffer!,
    safetyMarginMinScaled: margin!,
    safetyMarginEdgeFractionScaled: fraction!,
  });
  if (!ev.ok) return result(ev.reason);
  evidence["breakdown"] = Object.fromEntries(
    Object.entries(ev.value).map(([key, value]) => [
      key,
      typeof value === "bigint" ? formatScaled(value, 9) : value,
    ]),
  );
  if (!clearsEntryCriterion(ev.value) || ev.value.edgeNetScaled < minEdge!)
    return result("FINAL_ENTRY_EV_BELOW_MARGIN");
  return result("FINAL_ENTRY_ACCEPTED");
}
