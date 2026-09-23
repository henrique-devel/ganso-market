/** Deterministic quality machine. All time and observations are supplied by the
 * adapter; no networking, storage, timers, wall clock or external dependencies.
 */
export const FEED_LIMITS = Object.freeze({
  queue: 512,
  dedup: 2048,
  gaps: 32,
  sourceAgeMs: 10_000,
  futureToleranceMs: 1000,
  socketAgeMs: 15_000,
  bookSilenceMs: 10_000,
  contextSilenceMs: 15_000,
  tradeSilenceMs: 30_000,
});
export type FeedChannel = "book" | "trades" | "context";
type Reason =
  | "startup"
  | "disconnect"
  | "silence"
  | "invalid"
  | "out_of_order"
  | "source_stale"
  | "overflow";
type Observation = {
  channel: FeedChannel;
  key: string;
  source_timestamp: string | null;
  received_at: string;
  payload_hash: string;
};
type Quality = "fresh" | "stale" | "unknown";
type Delivery<T> = T & {
  quality: Quality;
  gap_epoch: number;
  revalidation: "none" | "current_state_only" | "delivery_resumed_only";
  continuity: "unproven";
};
interface ChannelState {
  status: "awaiting" | "healthy" | "stale" | "invalid" | "disconnected";
  last_received_at: number | null;
  last_source_at: number | null;
  source_quality: Quality;
  gap_epoch: number;
  needs_revalidation: boolean;
}
interface Gap {
  epoch: number;
  channel: FeedChannel;
  reason: Reason;
  detected_at: number;
  after_source_at: number | null;
  resumed_at: number | null;
  recovery: "pending" | "current_state_only" | "delivery_resumed_only";
}
const channels: FeedChannel[] = ["book", "trades", "context"];
const silence: Record<FeedChannel, number> = {
  book: FEED_LIMITS.bookSilenceMs,
  trades: FEED_LIMITS.tradeSilenceMs,
  context: FEED_LIMITS.contextSilenceMs,
};
export class FeedQualityMachine<T extends Observation> {
  private connected = false;
  private openedAt = 0;
  private lastMessageAt: number | null = null;
  private lastTradeAt: number | null = null;
  private epoch = 0;
  private readonly states = Object.fromEntries(
    channels.map((channel) => [
      channel,
      {
        status: "awaiting",
        last_received_at: null,
        last_source_at: null,
        source_quality: "unknown",
        gap_epoch: 0,
        needs_revalidation: true,
      },
    ]),
  ) as Record<FeedChannel, ChannelState>;
  private readonly seen = new Map<string, string>();
  private readonly queue: Delivery<T>[] = [];
  private readonly gaps: Gap[] = [];
  private readonly counts = {
    accepted: 0,
    duplicates: 0,
    stale: 0,
    out_of_order: 0,
    invalid: 0,
    dropped: 0,
    gaps: 0,
  };

  open(now: number): void {
    this.connected = true;
    this.openedAt = now;
    this.lastMessageAt = now;
    const reason = this.epoch === 0 ? "startup" : "disconnect";
    for (const channel of channels) {
      this.gap(channel, reason, now);
      this.states[channel].status = "awaiting";
    }
  }
  message(now: number): void {
    this.lastMessageAt = now;
  }
  disconnect(now: number): void {
    this.connected = false;
    for (const channel of channels) {
      this.gap(channel, "disconnect", now);
      this.states[channel].status = "disconnected";
    }
  }
  invalid(channel: FeedChannel, now: number): void {
    this.counts.invalid++;
    this.gap(channel, "invalid", now);
    this.states[channel].status = "invalid";
  }
  private gap(channel: FeedChannel, reason: Reason, now: number): void {
    const state = this.states[channel];
    // One open gap per channel; counters still account for every rejected input.
    if (state.needs_revalidation && state.gap_epoch !== 0) return;
    state.needs_revalidation = true;
    state.source_quality = "unknown";
    state.gap_epoch = ++this.epoch;
    this.counts.gaps++;
    this.gaps.push({
      epoch: this.epoch,
      channel,
      reason,
      detected_at: now,
      after_source_at: state.last_source_at,
      resumed_at: null,
      recovery: "pending",
    });
    if (this.gaps.length > FEED_LIMITS.gaps) this.gaps.shift();
  }
  tick(now: number): void {
    if (!this.connected) return;
    for (const channel of channels) {
      const state = this.states[channel];
      if (
        now -
          Math.max(state.last_received_at ?? this.openedAt, this.openedAt) >=
        silence[channel]
      ) {
        this.gap(channel, "silence", now);
        state.status = "stale";
        state.source_quality = "stale";
      }
      if (
        state.status === "healthy" &&
        state.last_source_at !== null &&
        now - state.last_source_at > FEED_LIMITS.sourceAgeMs
      ) {
        this.gap(channel, "source_stale", now);
        state.status = "stale";
        state.source_quality = "stale";
      }
    }
  }
  accept(event: T): void {
    if (!this.connected) return;
    const now = Date.parse(event.received_at);
    this.tick(now); // Silence remains visible even if no watchdog tick ran.
    const state = this.states[event.channel];
    const source =
      event.source_timestamp === null
        ? null
        : Date.parse(event.source_timestamp);
    const key = `${event.channel}:${event.key}`;
    if (this.seen.has(key)) {
      if (this.seen.get(key) !== event.payload_hash)
        this.invalid(event.channel, now);
      else this.counts.duplicates++;
      return;
    }
    this.seen.set(key, event.payload_hash);
    if (this.seen.size > FEED_LIMITS.dedup)
      this.seen.delete(this.seen.keys().next().value!);
    if (
      source !== null &&
      state.last_source_at !== null &&
      source < state.last_source_at
    ) {
      this.counts.out_of_order++;
      this.gap(event.channel, "out_of_order", now);
      state.status = "invalid";
      return; // Never regress a current snapshot or freshness watermark.
    }
    const quality: Quality =
      source === null
        ? "unknown"
        : now - source > FEED_LIMITS.sourceAgeMs ||
            source - now > FEED_LIMITS.futureToleranceMs
          ? "stale"
          : "fresh";
    if (quality === "stale") {
      this.counts.stale++;
      this.gap(event.channel, "source_stale", now);
      state.status = "stale";
      state.source_quality = "stale";
      return;
    }
    if (this.queue.length >= FEED_LIMITS.queue) {
      this.counts.dropped++;
      this.gap(event.channel, "overflow", now);
      state.status = "invalid";
      return;
    }
    const revalidation = state.needs_revalidation
      ? event.channel === "trades"
        ? "delivery_resumed_only"
        : "current_state_only"
      : "none";
    if (state.needs_revalidation) {
      const gap = this.gaps.find((entry) => entry.epoch === state.gap_epoch);
      if (gap) {
        gap.resumed_at = now;
        gap.recovery = revalidation as Exclude<typeof revalidation, "none">;
      }
    }
    state.needs_revalidation = false;
    state.last_received_at = now;
    state.last_source_at = source;
    state.source_quality = quality;
    state.status = "healthy";
    if (event.channel === "trades") this.lastTradeAt = source;
    this.counts.accepted++;
    this.queue.push({
      ...event,
      quality,
      gap_epoch: state.gap_epoch,
      revalidation,
      continuity: "unproven",
    });
  }
  drain(now: number): Delivery<T>[] {
    this.tick(now);
    return this.queue.splice(0).map((event) => ({
      ...event,
      // A slow consumer cannot receive old data labelled fresh.
      quality:
        event.quality === "fresh" &&
        now - Date.parse(event.source_timestamp!) > FEED_LIMITS.sourceAgeMs
          ? "stale"
          : this.states[event.channel].needs_revalidation ||
              this.states[event.channel].gap_epoch !== event.gap_epoch
            ? "unknown"
            : event.quality,
    }));
  }
  status(now: number) {
    this.tick(now);
    return {
      socket: {
        connected: this.connected,
        alive:
          this.connected &&
          this.lastMessageAt !== null &&
          now - this.lastMessageAt < FEED_LIMITS.socketAgeMs,
        last_message_at: this.lastMessageAt,
      },
      channels: {
        book: { ...this.states.book },
        trades: { ...this.states.trades },
        context: { ...this.states.context },
      },
      instrument: {
        activity:
          this.lastTradeAt !== null &&
          now - this.lastTradeAt <= FEED_LIMITS.sourceAgeMs
            ? ("recent_trade_observed" as const)
            : ("unknown" as const),
        last_trade_source_at: this.lastTradeAt,
        venue_trading_status: "unknown" as const,
      },
      continuity: "unproven" as const,
      gaps: this.gaps.map((entry) => ({ ...entry })),
      counters: { ...this.counts },
      buffers: {
        queued: this.queue.length,
        dedup: this.seen.size,
        gaps: this.gaps.length,
      },
      limits: FEED_LIMITS,
    };
  }
}
