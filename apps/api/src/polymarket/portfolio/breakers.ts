// RFC-013 task 4, item (v) and the four before it: the portfolio-level circuit
// breakers that freeze NEW ENTRIES and force an exit re-evaluation.
//
// These are not the RFC-012 breaker. That one is the authoritative
// resolution-risk verdict for a market and the engine consults it separately
// (an entry never happens over a VETO or a CIRCUIT_BREAKER action). What this
// file records is what the PORTFOLIO observed: the five conditions the RFC
// enumerates, each opened with the evidence that opened it and closed when that
// evidence clears.
//
// Scope choices, and why they are what they are:
//
//   * A dispute, a material clarification and a staleness breach are scoped to
//     the market (or token) they happened to, not to the whole portfolio. The
//     RFC-011 paper broker already settled this precedent — "markets with an
//     active UMA dispute while holding a position: entries frozen per market
//     without engaging the global switch" — and freezing an entire book because
//     one held position went to dispute would be a different control than the
//     one the RFC describes.
//   * A dispute, a clarification and a staleness breach only matter where there
//     is something to protect, so they are evaluated for markets with an OPEN
//     POSITION. For an entry the engine already refuses on the same evidence,
//     with a rejection code that says so.
//   * An unexplained price jump and a venue parameter change are evaluated for
//     the whole eligible universe: both are reasons not to enter a market we do
//     not hold yet.

import { div, parseScaled } from "../fundamental/fixed.js";
import { money } from "./ev.js";
import type { BreakerKind } from "./types.js";

export type BreakerScope = "market" | "token" | "portfolio";

/** One breaker the portfolio believes should be open right now. */
export interface BreakerSignal {
  readonly kind: BreakerKind;
  readonly scope: BreakerScope;
  readonly conditionId: string | null;
  readonly tokenId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Everything the detector needs about one market at one instant. Every field is
 * read from data another RFC already recorded; this module opens no connection
 * and derives no new source.
 */
export interface BreakerObservation {
  readonly conditionId: string;
  readonly tokenId: string;
  /** True when the market has an open paper position. */
  readonly holdsPosition: boolean;

  /** RFC-012: UMA request proposed or disputed for this market. */
  readonly disputeActive: boolean;
  /** RFC-012 effective action, which also carries the group coupling. */
  readonly resolutionAction:
    "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER" | null;

  /** Executable mid now and one jump window ago, scaled. Null when unknown. */
  readonly midNowScaled: bigint | null;
  readonly midBeforeScaled: bigint | null;
  /**
   * True when something in the window explains a move: the market's own
   * resolution instant, or a macro release the calendar knew about. A jump WITH
   * a catalyst is information arriving, which is not what this breaker is for.
   */
  readonly knownCatalystInWindow: boolean;

  /** Instant of the newest MATERIAL clarification, or null. */
  readonly clarifiedAt: Date | null;
  /** Instant the newest venue parameter version became valid, or null. */
  readonly paramChangedAt: Date | null;

  /** Age of the newest recorded book, in ms. Null when there is no book. */
  readonly bookAgeMs: number | null;
}

export interface BreakerConfigInput {
  /** Mid move inside jumpWindowMs with no known catalyst opens the breaker. */
  readonly jumpThresholdScaled: bigint;
  readonly jumpWindowMs: number;
  /** Book older than this is stale (the same TTL the entry gate uses). */
  readonly bookMaxAgeMs: number;
}

/**
 * How recent a clarification or parameter change has to be to hold a breaker
 * open. Without a window a single historical clarification would freeze a
 * market forever; with one, the freeze lasts long enough to be noticed and
 * acted on, then lifts and leaves the append-only record behind.
 */
export const BREAKER_EVENT_WINDOW_MS = 24 * 3_600_000;

function relativeMove(now: bigint, before: bigint): bigint {
  if (before <= 0n) {
    return 0n;
  }
  const delta = now >= before ? now - before : before - now;
  return div(delta, before);
}

/**
 * Every breaker that should be OPEN for this market at this instant.
 *
 * The function is total: it returns the full set rather than the first hit, so
 * a market frozen for two reasons records both. Reconciliation against what is
 * already open is the store's job — this file decides only what is true.
 */
export function detectBreakers(input: {
  readonly observation: BreakerObservation;
  readonly config: BreakerConfigInput;
  readonly now: Date;
}): BreakerSignal[] {
  const { observation: o, config, now } = input;
  const signals: BreakerSignal[] = [];

  // (i) A UMA request proposed or disputed on a market we hold. Never increase,
  //     and re-evaluate the exit on the trinary payoff — the precedents
  //     (Ukraine-minerals, Zelensky, Strategy/BTC) did not refund.
  if (
    o.holdsPosition &&
    (o.disputeActive || o.resolutionAction === "CIRCUIT_BREAKER")
  ) {
    signals.push({
      kind: "UMA_PROPOSED_OR_DISPUTED",
      scope: "market",
      conditionId: o.conditionId,
      tokenId: null,
      detail: {
        dispute_active: o.disputeActive,
        resolution_action: o.resolutionAction,
        basis: "posição aberta em mercado com pedido UMA proposto ou disputado",
      },
    });
  }

  // (ii) A jump beyond the threshold with nothing in the window to explain it.
  //      The documented patterns are 17%->95% and 9%->100%; a move that size
  //      with no catalyst is either information nobody published or a book
  //      being pushed, and neither is a reason to enter.
  if (o.midNowScaled !== null && o.midBeforeScaled !== null) {
    const move = relativeMove(o.midNowScaled, o.midBeforeScaled);
    if (move > config.jumpThresholdScaled && !o.knownCatalystInWindow) {
      signals.push({
        kind: "PRICE_JUMP_NO_CATALYST",
        scope: "token",
        conditionId: o.conditionId,
        tokenId: o.tokenId,
        detail: {
          mid_before: money(o.midBeforeScaled),
          mid_now: money(o.midNowScaled),
          relative_move: money(move),
          threshold: money(config.jumpThresholdScaled),
          window_ms: config.jumpWindowMs,
        },
      });
    }
  }

  // (iii) A material clarification on a market we hold. The rule the position
  //       was opened against is not the rule that will settle it.
  if (
    o.holdsPosition &&
    o.clarifiedAt !== null &&
    now.getTime() - o.clarifiedAt.getTime() <= BREAKER_EVENT_WINDOW_MS
  ) {
    signals.push({
      kind: "RULE_CLARIFICATION",
      scope: "market",
      conditionId: o.conditionId,
      tokenId: null,
      detail: {
        clarified_at: o.clarifiedAt.toISOString(),
        window_ms: BREAKER_EVENT_WINDOW_MS,
      },
    });
  }

  // (iv) Fee schedule, tick or status changed. Every cost in the EV was
  //      computed under the old parameters.
  if (
    o.paramChangedAt !== null &&
    now.getTime() - o.paramChangedAt.getTime() <= BREAKER_EVENT_WINDOW_MS
  ) {
    signals.push({
      kind: "PARAM_CHANGE",
      scope: "market",
      conditionId: o.conditionId,
      tokenId: null,
      detail: {
        param_changed_at: o.paramChangedAt.toISOString(),
        window_ms: BREAKER_EVENT_WINDOW_MS,
      },
    });
  }

  // (v) Data staleness past the TTL, on a market we hold. For an entry the
  //     engine already refuses with BOOK_STALE; what a held position needs is
  //     the exit re-evaluation this breaker forces.
  if (
    o.holdsPosition &&
    (o.bookAgeMs === null || o.bookAgeMs > config.bookMaxAgeMs)
  ) {
    signals.push({
      kind: "DATA_STALENESS",
      scope: "token",
      conditionId: o.conditionId,
      tokenId: o.tokenId,
      detail: {
        book_age_ms: o.bookAgeMs,
        ttl_ms: config.bookMaxAgeMs,
      },
    });
  }

  return signals;
}

/** Identity of a breaker, for reconciling detected against already-open. */
export function breakerKey(signal: {
  readonly kind: BreakerKind;
  readonly scope: BreakerScope;
  readonly conditionId: string | null;
  readonly tokenId: string | null;
}): string {
  return [
    signal.kind,
    signal.scope,
    signal.conditionId ?? "",
    signal.tokenId ?? "",
  ].join("|");
}

export interface OpenBreakerRow {
  readonly breakerId: number;
  readonly kind: BreakerKind;
  readonly scope: BreakerScope;
  readonly conditionId: string | null;
  readonly tokenId: string | null;
}

export interface BreakerReconciliation {
  readonly toOpen: readonly BreakerSignal[];
  readonly toClose: readonly OpenBreakerRow[];
}

/**
 * Diff the detected set against the open set.
 *
 * A breaker that is still true is left alone: re-opening it would fragment its
 * window and lose the fact that the condition never lifted. A breaker that is
 * no longer detected is closed, which is what makes `ended_at` mean "the
 * condition cleared" rather than "the process restarted".
 */
export function reconcileBreakers(input: {
  readonly detected: readonly BreakerSignal[];
  readonly open: readonly OpenBreakerRow[];
}): BreakerReconciliation {
  const detectedKeys = new Set(input.detected.map((s) => breakerKey(s)));
  const openKeys = new Set(input.open.map((row) => breakerKey(row)));
  return {
    toOpen: input.detected.filter((s) => !openKeys.has(breakerKey(s))),
    toClose: input.open.filter((row) => !detectedKeys.has(breakerKey(row))),
  };
}

/**
 * True when an entry into this market/token must be refused because a portfolio
 * breaker is open.
 *
 * `PARAM_CHANGE` and `PRICE_JUMP_NO_CATALYST` freeze entries into the affected
 * market; `UMA_PROPOSED_OR_DISPUTED` and `RULE_CLARIFICATION` do too, and
 * additionally forbid increasing the existing position. `DATA_STALENESS` is the
 * one that does not need to be consulted here, because the entry gate refuses a
 * stale book on its own — but consulting it costs nothing and keeps the two
 * paths from disagreeing.
 */
export function entryFrozenBy(
  open: readonly OpenBreakerRow[],
  conditionId: string,
  tokenId: string,
): OpenBreakerRow | null {
  return (
    open.find(
      (row) =>
        row.scope === "portfolio" ||
        (row.scope === "market" && row.conditionId === conditionId) ||
        (row.scope === "token" && row.tokenId === tokenId),
    ) ?? null
  );
}

/** Executable mid of a recorded book, or null when either side is missing. */
export function executableMid(
  bids: readonly { readonly price: string }[],
  asks: readonly { readonly price: string }[],
): bigint | null {
  const bid = bids[0] === undefined ? null : parseScaled(bids[0].price);
  const ask = asks[0] === undefined ? null : parseScaled(asks[0].price);
  if (bid === null || ask === null || bid <= 0n || ask <= 0n) {
    return null;
  }
  return (bid + ask) / 2n;
}
