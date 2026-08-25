// RFC-012 task 1: the per-request UMA timeline. proposed -> (disputed ->
// reset) -> (disputed -> DVM) -> settled, at most 2 requests, results P1..P4.
// Semantics from the UMA CTF Adapter (verified against the v2/v3 interfaces):
// the FIRST dispute resets the question (a new request, the clock restarts);
// the SECOND dispute escalates to the DVM; after that only a manual path
// remains. v1 derives from the Gamma status timeline already recorded by
// RFC-007; the onchain collector (part 2) appends exact events with its own
// source tag. Derivation is a pure function; persistence is idempotent
// (dedupe constraint absorbs replays), so out-of-order polling can never
// duplicate or mutate history.

import type { ResolutionPool, UmaResult, UmaTimelineState } from "./types.js";

export interface GammaTimelineEvent {
  readonly eventType: string;
  readonly receivedAt: Date;
  readonly payload: unknown;
}

export interface TimelineEntry {
  readonly conditionId: string;
  readonly requestIndex: 1 | 2;
  readonly state: UmaTimelineState;
  readonly result: UmaResult | null;
  readonly payouts: readonly string[] | null;
  readonly source: "gamma" | "onchain";
  readonly sourceRef: string | null;
  readonly occurredAt: Date;
}

interface ResolvedOutcome {
  readonly result: UmaResult | null;
  readonly payouts: readonly string[] | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const items = parsed.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length === parsed.length && items.length > 0 ? items : null;
}

/**
 * P1 = NO, P2 = YES, P3 = 50/50. P4 (premature) never reaches the Gamma
 * timeline — it is only visible onchain as a too-early reset. The YES outcome
 * is located by name; a market without a literal "Yes" outcome falls back to
 * index 0 (the convention of every binary market recorded so far).
 */
export function outcomeFromPayload(payload: unknown): ResolvedOutcome {
  const record = asRecord(payload);
  if (record === null) {
    return { result: null, payouts: null };
  }
  const raw = asRecord(record.raw);
  const prices =
    stringList(record.outcomePrices) ?? stringList(raw?.outcomePrices) ?? null;
  const outcomes =
    stringList(record.outcomes) ?? stringList(raw?.outcomes) ?? null;
  if (prices === null) {
    return { result: null, payouts: null };
  }
  const normalized = prices.map((price) => Number(price));
  if (normalized.some((price) => !Number.isFinite(price))) {
    return { result: null, payouts: prices };
  }
  if (normalized.every((price) => Math.abs(price - 0.5) < 1e-9)) {
    return { result: "P3", payouts: prices };
  }
  let yesIndex = 0;
  if (outcomes !== null) {
    const found = outcomes.findIndex((name) => /^yes$/i.test(name.trim()));
    if (found >= 0) {
      yesIndex = found;
    }
  }
  const yesPrice = normalized[yesIndex];
  if (yesPrice === undefined) {
    return { result: null, payouts: prices };
  }
  return { result: yesPrice >= 0.5 ? "P2" : "P1", payouts: prices };
}

/**
 * Fold the chronological Gamma status events of one market into timeline
 * entries. The machine never skips a request transition: dispute #1 emits
 * disputed+reset on request 1, the next proposal (or dispute) belongs to
 * request 2, dispute #2 emits disputed+dvm, and a resolution settles the
 * request that was live. Inputs MUST be sorted by (receivedAt, id) — the
 * caller sorts, so replays and out-of-order deliveries derive identically.
 */
export function deriveGammaTimeline(
  conditionId: string,
  events: readonly GammaTimelineEvent[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let requestIndex: 1 | 2 = 1;
  let disputes = 0;
  let settled = false;

  const push = (
    state: UmaTimelineState,
    event: GammaTimelineEvent,
    outcome: ResolvedOutcome | null = null,
  ): void => {
    entries.push({
      conditionId,
      requestIndex,
      state,
      result: outcome?.result ?? null,
      payouts: outcome?.payouts ?? null,
      source: "gamma",
      sourceRef: null,
      occurredAt: event.receivedAt,
    });
  };

  for (const event of events) {
    if (settled) {
      break;
    }
    switch (event.eventType) {
      case "proposed": {
        push("proposed", event);
        break;
      }
      case "disputed": {
        disputes += 1;
        push("disputed", event);
        if (disputes === 1) {
          // First dispute: the adapter deletes the price and re-requests —
          // the question resets and the next lifecycle is request 2.
          push("reset", event);
          requestIndex = 2;
        } else {
          // Second dispute: no reset left; the DVM vote decides.
          push("dvm", event);
        }
        break;
      }
      case "resolved":
      case "market_resolved": {
        push("settled", event, outcomeFromPayload(event.payload));
        settled = true;
        break;
      }
      default:
        // 'closed' and 'rule_change' carry no request-lifecycle information.
        break;
    }
  }
  return entries;
}

/** Load one market's status events (chronological) up to the instant. */
export async function loadGammaEvents(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
): Promise<GammaTimelineEvent[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT event_type, payload_json, received_at
       FROM polymarket_resolution_events
      WHERE condition_id = $1
        AND received_at <= $2
        AND event_type IN ('proposed', 'disputed', 'resolved', 'market_resolved')
      ORDER BY received_at ASC, resolution_event_id ASC`,
    [conditionId, asOf],
  );
  const events: GammaTimelineEvent[] = [];
  for (const row of result.rows) {
    const eventType = row.event_type;
    const receivedAt = row.received_at;
    if (typeof eventType !== "string" || !(receivedAt instanceof Date)) {
      if (typeof eventType === "string" && typeof receivedAt === "string") {
        const parsed = new Date(receivedAt);
        if (!Number.isNaN(parsed.getTime())) {
          events.push({
            eventType,
            receivedAt: parsed,
            payload: row.payload_json,
          });
        }
      }
      continue;
    }
    events.push({ eventType, receivedAt, payload: row.payload_json });
  }
  return events;
}

/**
 * Persist derived entries. Idempotent: the dedupe constraint absorbs replays;
 * bond/liveness context rides along from the rule version at the entry's
 * instant (the caller provides it once per market).
 */
export async function persistTimeline(
  pool: ResolutionPool,
  entries: readonly TimelineEntry[],
  context: {
    questionId: string | null;
    bond: string | null;
    customLiveness: string | null;
  },
): Promise<number> {
  let inserted = 0;
  for (const entry of entries) {
    const result = await pool.query(
      `INSERT INTO resolution_uma_timeline
         (condition_id, question_id, request_index, state, result,
          payouts_json, bond, custom_liveness, source, source_ref, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
       ON CONFLICT ON CONSTRAINT resolution_uma_timeline_dedupe DO NOTHING`,
      [
        entry.conditionId,
        context.questionId,
        entry.requestIndex,
        entry.state,
        entry.result,
        entry.payouts === null ? null : JSON.stringify(entry.payouts),
        context.bond,
        context.customLiveness,
        entry.source,
        entry.sourceRef,
        entry.occurredAt,
      ],
    );
    inserted += result.rowCount;
  }
  return inserted;
}
