// RFC-010 tasks 3, 4 and 10: the decision that turns a book, an optional model
// output and the module configuration into the rows of `fundamental_estimates`.
//
// This module is a PURE FUNCTION. It performs no I/O of any kind (the book is
// handed to it already read), it never throws for an anomalous input, and it
// is the single place where the deterministic fallback lives:
//
//   invalid book                  -> NO estimate at all (explicit absence)
//   no promoted model             -> MARKET_BASELINE, reason NO_ACTIVE_MODEL
//   model in shadow               -> MARKET_BASELINE for the consumer plus a
//                                    separate shadow MODEL row for the gate
//   model error/timeout/abstain   -> MARKET_BASELINE with that reason
//   stale external feed           -> MARKET_BASELINE, reason FEED_STALE
//   unknown git sha               -> MARKET_BASELINE, PROVENANCE_UNAVAILABLE
//   active UMA dispute            -> MARKET_BASELINE, UMA_DISPUTE_ACTIVE
//
// The baseline is never switchable off, and the fallback interval is always
// wider than the raw baseline interval.

import type { FundamentalConfig } from "./config.js";
import {
  formatProbabilityScaled,
  formatScaled,
  PROB_DIGITS,
  probabilityToScaled,
} from "./fixed.js";
import { buildInterval, type IntervalResult } from "./interval.js";
import {
  computeMicroprice,
  isThinBook,
  MICROPRICE_VERSION,
} from "./microprice.js";
import type {
  BookInvalidReason,
  BookView,
  DataRefs,
  Estimate,
  EstimateFlags,
  FallbackReason,
  Microprice,
  ModelOutput,
  ModelResult,
  ModelStatus,
} from "./types.js";

/** One model's attempt at this token and instant. */
export interface ModelAttempt {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly status: ModelStatus;
  readonly result: ModelResult;
}

export interface EstimateInputs {
  readonly marketId: string;
  readonly tokenId: string;
  /** Recorded category; not every category has a model. */
  readonly category: string;
  /**
   * False when no model owns this category. The token still gets a baseline
   * estimate — "for every token of the universe with a valid book there is an
   * estimate" is an acceptance criterion, not a best effort.
   */
  readonly categoryModelled?: boolean;
  readonly decisionTs: Date;
  readonly book: BookView | null;
  /** The promoted model for this category, when one exists. */
  readonly activeModel: ModelAttempt | null;
  /** Models still proving themselves; their rows are invisible to consumers. */
  readonly shadowModels: readonly ModelAttempt[];
  /** Revision of the running code; null blocks every MODEL row. */
  readonly gitSha: string | null;
  /** VETO: an open UMA dispute forces the baseline. */
  readonly umaDisputeActive: boolean;
  readonly ruleChangedRecently: boolean;
  /** Milliseconds from the decision instant to resolution, when known. */
  readonly timeToResolutionMs: number | null;
  readonly config: FundamentalConfig;
}

export type EstimateDecision =
  | {
      readonly kind: "estimates";
      /** The row a consumer reads: MODEL only when a promoted model served. */
      readonly consumer: Estimate;
      /** Shadow rows, written for the gate and invisible to consumers. */
      readonly shadow: readonly Estimate[];
      readonly microprice: Microprice;
    }
  | { readonly kind: "absent"; readonly reason: BookInvalidReason };

/**
 * The RFC requires data_refs to carry the source_ts of every input window. It
 * deliberately carries NOTHING that is already a column (the interval and
 * microprice versions, the executable spread) and nothing that is exactly
 * reconstructible from the recorded book: this jsonb is written once per token
 * per minute for the whole universe, so every redundant key is paid for in the
 * module's storage quota for ninety days.
 */
function bookRefs(book: BookView, microprice: Microprice): DataRefs {
  return {
    bookSourceTs: book.sourceTs === null ? null : book.sourceTs.toISOString(),
    bookObservedAt: book.observedAt.toISOString(),
    bookAgeMs: microprice.bookAgeMs,
    bidExec: formatScaled(microprice.bidExecScaled, PROB_DIGITS),
    askExec: formatScaled(microprice.askExecScaled, PROB_DIGITS),
  };
}

function toEstimate(
  inputs: EstimateInputs,
  microprice: Microprice,
  interval: IntervalResult,
  options: {
    readonly source: "MODEL" | "MARKET_BASELINE";
    readonly status: "shadow" | "active";
    readonly provenance: Estimate["provenance"];
    readonly dataRefs: DataRefs;
    readonly flags: EstimateFlags;
    readonly fallbackReason: FallbackReason | null;
  },
): Estimate {
  return {
    marketId: inputs.marketId,
    tokenId: inputs.tokenId,
    category: inputs.category,
    decisionTs: inputs.decisionTs,
    q: formatProbabilityScaled(interval.qScaled),
    qLo: formatProbabilityScaled(interval.qLoScaled),
    qHi: formatProbabilityScaled(interval.qHiScaled),
    source: options.source,
    status: options.status,
    provenance: options.provenance,
    dataRefs: {
      ...options.dataRefs,
      horizonBucket: interval.horizon,
    },
    marketProb: formatProbabilityScaled(microprice.micropriceScaled),
    execSpread: formatScaled(microprice.execSpreadScaled, PROB_DIGITS),
    flags: options.flags,
    fallbackReason: options.fallbackReason,
    intervalVersion: interval.version,
    micropriceVersion: MICROPRICE_VERSION,
  };
}

type ResolvedAttempt =
  | { readonly ok: false; readonly reason: FallbackReason }
  | {
      readonly ok: true;
      readonly attempt: ModelAttempt;
      readonly output: ModelOutput;
    };

/**
 * Reduce a model attempt to either an output that may be served or the reason
 * it may not. A single place decides this so no model can bypass the rules.
 */
function resolveAttempt(
  attempt: ModelAttempt | null,
  gitSha: string | null,
  umaDisputeActive: boolean,
): ResolvedAttempt {
  // The dispute veto is a property of the MARKET, not of any model, so it is
  // reported first. Otherwise a disputed market with no promoted model would
  // be recorded as "no model registered" and the veto would be invisible.
  if (umaDisputeActive) {
    return { ok: false, reason: "UMA_DISPUTE_ACTIVE" };
  }
  if (attempt === null) {
    return { ok: false, reason: "NO_ACTIVE_MODEL" };
  }
  if (gitSha === null) {
    // Provenance is not optional: a MODEL row without a revision is a bug,
    // so the model simply does not serve.
    return { ok: false, reason: "PROVENANCE_UNAVAILABLE" };
  }
  if (!attempt.result.ok) {
    return { ok: false, reason: attempt.result.reason };
  }
  if (attempt.result.value.feedStale) {
    return { ok: false, reason: "FEED_STALE" };
  }
  if (!Number.isFinite(attempt.result.value.q)) {
    return { ok: false, reason: "MODEL_ERROR" };
  }
  // A NaN or negative sigma silently becomes "no dispersion", i.e. the
  // narrowest interval the structural floor allows — a model claiming
  // certainty it never expressed. Refuse it.
  const sigma = attempt.result.value.sigma;
  if (!Number.isFinite(sigma) || sigma < 0) {
    return { ok: false, reason: "MODEL_ERROR" };
  }
  return { ok: true, attempt, output: attempt.result.value };
}

/** Decide the estimate rows for one token at one instant. Never throws. */
export function decideEstimate(inputs: EstimateInputs): EstimateDecision {
  if (inputs.book === null) {
    return { kind: "absent", reason: "NO_BOOK" };
  }
  const priced = computeMicroprice(inputs.book, inputs.decisionTs, {
    sRefUsd: inputs.config.sRefUsd,
    maxBookAgeMs: inputs.config.maxBookAgeMs,
    maxExecSpread: inputs.config.maxExecSpread,
  });
  if (!priced.ok) {
    // No valid book means no estimate at all. The consumer treats an absent
    // estimate as a veto; it must never see a stale or defaulted number.
    return { kind: "absent", reason: priced.reason };
  }
  const microprice = priced.value;
  const book = inputs.book;
  const thinBook = isThinBook(microprice, inputs.config.thinBookMultiple);
  const baseFlags: EstimateFlags = {
    bookStale: false,
    feedStale: false,
    thinBook,
    ruleChangedRecently: inputs.ruleChangedRecently,
  };

  const intervalBase = {
    execSpreadScaled: microprice.execSpreadScaled,
    bookAgeMs: microprice.bookAgeMs,
    maxBookAgeMs: inputs.config.maxBookAgeMs,
    // Each category's "feed" has its own natural freshness scale: the crypto
    // model reads a TWAP sample that must be seconds old, the macro model
    // reads a calendar entry that is legitimately days old. Measuring both
    // against the crypto threshold would saturate every macro estimate at the
    // maximum staleness widening and make the signal meaningless.
    maxFeedAgeMs:
      inputs.category === "macro_scheduled"
        ? inputs.config.macro.maxCalendarAgeMs
        : inputs.config.crypto.maxFeedAgeMs,
    timeToResolutionMs: inputs.timeToResolutionMs,
  };

  const active =
    inputs.categoryModelled === false
      ? ({ ok: false, reason: "CATEGORY_NOT_MODELLED" } as const)
      : resolveAttempt(
          inputs.activeModel,
          inputs.gitSha,
          inputs.umaDisputeActive,
        );

  let consumer: Estimate;
  if (active.ok && active.attempt.status === "active") {
    const output = active.output;
    const interval = buildInterval({
      ...intervalBase,
      qScaled: probabilityToScaled(output.q),
      sigma: output.sigma,
      feedAgeMs: output.feedAgeMs ?? null,
      widenFactor: 1,
    });
    consumer = toEstimate(inputs, microprice, interval, {
      source: "MODEL",
      status: "active",
      provenance: {
        modelId: active.attempt.modelId,
        modelVersion: active.attempt.modelVersion,
        featureSetVersion: output.featureSetVersion,
        gitSha: inputs.gitSha ?? "",
      },
      // The book's provenance is spread LAST on purpose: a model that
      // reads no book still has to satisfy the DataRefs contract and fills
      // those keys with placeholders. The real recorded source_ts must win.
      dataRefs: { ...output.dataRefs, ...bookRefs(book, microprice) },
      flags: { ...baseFlags, thinBook: thinBook || output.thinBook },
      fallbackReason: null,
    });
  } else {
    // NO_ACTIVE_MODEL means nothing was ever registered for this category;
    // MODEL_IN_SHADOW means a model exists and simply has not earned promotion
    // yet. The distinction is what an operator reads to know whether the gate
    // is the thing standing in the way.
    const rawReason: FallbackReason = active.ok
      ? "MODEL_IN_SHADOW"
      : active.reason;
    const reason: FallbackReason =
      rawReason === "NO_ACTIVE_MODEL" && inputs.shadowModels.length > 0
        ? "MODEL_IN_SHADOW"
        : rawReason;
    const interval = buildInterval({
      ...intervalBase,
      qScaled: microprice.micropriceScaled,
      sigma: 0,
      feedAgeMs: null,
      widenFactor: inputs.config.fallbackWidenFactor,
    });
    consumer = toEstimate(inputs, microprice, interval, {
      source: "MARKET_BASELINE",
      status: "active",
      provenance: null,
      dataRefs: bookRefs(book, microprice),
      flags: { ...baseFlags, feedStale: reason === "FEED_STALE" },
      fallbackReason: reason,
    });
  }

  // Shadow rows: every model that is not promoted yet. A promoted model that
  // could not serve this instant simply has no row; its failure is already
  // recorded as the consumer row's fallback reason.
  const shadowAttempts: ModelAttempt[] = [...inputs.shadowModels];
  const activeAttempt = inputs.activeModel;
  if (
    activeAttempt !== null &&
    activeAttempt.status === "shadow" &&
    !shadowAttempts.some(
      (candidate) => candidate.modelId === activeAttempt.modelId,
    )
  ) {
    shadowAttempts.push(activeAttempt);
  }

  const shadow: Estimate[] = [];
  for (const attempt of inputs.categoryModelled === false
    ? []
    : shadowAttempts) {
    const resolved = resolveAttempt(
      attempt,
      inputs.gitSha,
      inputs.umaDisputeActive,
    );
    if (!resolved.ok) {
      continue;
    }
    const output = resolved.output;
    const interval = buildInterval({
      ...intervalBase,
      qScaled: probabilityToScaled(output.q),
      sigma: output.sigma,
      feedAgeMs: output.feedAgeMs ?? null,
      widenFactor: 1,
    });
    shadow.push(
      toEstimate(inputs, microprice, interval, {
        source: "MODEL",
        status: "shadow",
        provenance: {
          modelId: attempt.modelId,
          modelVersion: attempt.modelVersion,
          featureSetVersion: output.featureSetVersion,
          gitSha: inputs.gitSha ?? "",
        },
        // The book's provenance is spread LAST on purpose: a model that
        // reads no book still has to satisfy the DataRefs contract and fills
        // those keys with placeholders. The real recorded source_ts must win.
        dataRefs: { ...output.dataRefs, ...bookRefs(book, microprice) },
        flags: { ...baseFlags, thinBook: thinBook || output.thinBook },
        fallbackReason: null,
      }),
    );
  }

  return { kind: "estimates", consumer, shadow, microprice };
}
