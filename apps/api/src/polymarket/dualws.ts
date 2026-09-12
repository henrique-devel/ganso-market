import { createHash } from "node:crypto";

import {
  MARKET_WS_URL,
  subscribeMessage,
  type MarketSocketFactory,
} from "./recorder.js";
import { errorFields } from "../errors.js";

// RFC-007 task 4: two independent connections to the market WSS with
// content-based dedupe. The feed drops frames; a frame lost on one connection
// but delivered on the other is NOT a gap. Only both connections being down
// simultaneously is a gap (the caller records a clob_ws gap and re-syncs).

export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_MS = 30_000;
export const DEFAULT_DEDUPE_MAX_ENTRIES = 50_000;
export const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
const CONNECTION_COUNT = 2;

export interface BothDownInfo {
  /** clock() reading when the second connection went down. */
  readonly downSince: number;
}

export interface DualSocketDeps {
  readonly socketFactory: MarketSocketFactory;
  readonly url?: string;
  readonly tokenIds: readonly string[];
  /** Deduped frames (first copy wins; "PONG" keepalives are filtered out). */
  readonly onMessage: (raw: string) => void;
  /** Current, open socket frames before deduped delivery; excludes PING/PONG. */
  readonly onObservation?: (raw: string, firstCopy: boolean) => void;
  /** Both connections down at once: the caller records a clob_ws gap. */
  readonly onBothDown: (info: BothDownInfo) => void;
  readonly heartbeatMs?: number;
  readonly clock?: () => number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly dedupeMaxEntries?: number;
  readonly dedupeWindowMs?: number;
}

export interface DualSocketStats {
  /** Frames forwarded to onMessage (first copies). */
  readonly messagesForwarded: number;
  /** Second copies silently dropped by the dedupe (not gaps). */
  readonly duplicatesDropped: number;
  /** Times one connection dropped while the other stayed up (not gaps). */
  readonly singleConnectionDrops: number;
  /** Times both connections were down simultaneously (gaps). */
  readonly bothDownEvents: number;
  /** Reconnect attempts per connection slot. */
  readonly reconnects: readonly number[];
  /** Connections currently open. */
  readonly openConnections: number;
  /**
   * RFC-024 D3: rolling reconnects driven by tokens ENTERING the universe.
   * Separate from `reconnects`, which counts recovery from a drop — these are
   * deliberate, and the two must not be read as one number.
   */
  readonly rollingResubscribes: number;
  /** Resubscribes that only removed tokens, so no reconnect was needed. */
  readonly resubscribesWithoutEntry: number;
}

export interface DualMarketSocket {
  /**
   * Swap the subscribed universe.
   *
   * RFC-024 D3, and the branch this file predicted: "If the venue ever
   * requires a fresh socket per subscription, close/reopen here instead". It
   * does. Measured 2026-09-08 in two independent ways:
   *
   * - **On the wire** (`wire-probe-cli`, 02:42:28Z): a second `subscribe`
   *   frame on a LIVE connection carrying a token that was not in the first
   *   frame produced `NEVER_ON_A` — no `book` in 120 s — while a connection
   *   opened at the same instant with only that token got its `book` in
   *   **21 ms**. The token was live and the venue was willing to serve it;
   *   the frame was simply ignored. The old tokens kept flowing (4 497
   *   frames), so the frame does not REPLACE the subscription either — the
   *   RTDS pattern the hypothesis was built on. It is ignored, not swapped.
   * - **In production** (02:51:45Z): the six tokens the gamma cycle added via
   *   `resubscribe` all opened a `subscribe_book_missing` gap at 02:52:45,
   *   including both tokens of the market the series source had just
   *   discovered 68,3 min before its end. In the same process, at boot, 162
   *   tokens subscribed on FRESH connections produced **zero** gaps.
   *
   * So a token added to a live socket never gets a book, and only a new
   * connection does. `resubscribe` therefore RECONNECTS when tokens enter,
   * one slot at a time, and the twin keeps delivering throughout — the caller
   * never sees `onBothDown` because of a resubscribe.
   *
   * Exits alone do not reconnect: a shrinking list needs no new book, and
   * churning the socket for it would pay the re-book cost for nothing.
   */
  resubscribe(tokenIds: readonly string[]): void;
  /**
   * Recover an open-but-silent feed by retiring both sockets. Reuses each
   * slot's reconnect backoff; repeated calls never duplicate pending timers.
   * The caller owns the silence thresholds and recovery-attempt budget.
   */
  reconnectSilent(): void;
  close(): void;
  stats(): DualSocketStats;
}

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

// Content dedupe: sha256 of the normalized raw frame, kept in an
// insertion-ordered Map used as an LRU with a size cap and a time window.
// The digest covers the frame content only, so the same event arriving on
// either connection maps to the same key.
class FrameDeduper {
  readonly #seen = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #windowMs: number;

  public constructor(maxEntries: number, windowMs: number) {
    this.#maxEntries = maxEntries;
    this.#windowMs = windowMs;
  }

  /** Returns true when this frame is the first copy inside the window. */
  public firstCopy(raw: string, nowMs: number): boolean {
    const digest = createHash("sha256").update(raw.trim()).digest("hex");
    const seenAt = this.#seen.get(digest);
    if (seenAt !== undefined && nowMs - seenAt <= this.#windowMs) {
      return false;
    }
    // Delete before set so a refresh moves the key to the newest LRU slot.
    this.#seen.delete(digest);
    this.#seen.set(digest, nowMs);
    while (this.#seen.size > this.#maxEntries) {
      const oldest = this.#seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#seen.delete(oldest);
    }
    return true;
  }
}

interface ConnectionSlot {
  socket: ReturnType<MarketSocketFactory> | null;
  open: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  reconnects: number;
}

/**
 * Two independent market WebSocket connections with content dedupe. Each
 * connection subscribes on open, sends PING heartbeats, and reconnects with
 * exponential backoff (base 1s, cap 30s) plus resubscribe. First copy of a
 * frame wins; the second copy is dropped silently (dedupe, not a gap).
 */
export function createDualMarketSocket(deps: DualSocketDeps): DualMarketSocket {
  const url = deps.url ?? MARKET_WS_URL;
  const clock = deps.clock ?? ((): number => Date.now());
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const deduper = new FrameDeduper(
    deps.dedupeMaxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES,
    deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS,
  );

  let tokenIds: readonly string[] = [...deps.tokenIds];
  let closed = false;
  let bothDownSince: number | null = null;
  let messagesForwarded = 0;
  let duplicatesDropped = 0;
  let singleConnectionDrops = 0;
  let bothDownEvents = 0;
  let rollingResubscribes = 0;
  let resubscribesWithoutEntry = 0;
  // RFC-024 D3: the rolling reconnect is at most one per resubscribe, and one
  // slot at a time. This holds the slot index still being cycled, so a second
  // resubscribe arriving before the first slot is back up does not take the
  // twin down with it.
  let rollingSlot: number | null = null;

  const slots: ConnectionSlot[] = Array.from(
    { length: CONNECTION_COUNT },
    (): ConnectionSlot => ({
      socket: null,
      open: false,
      heartbeat: null,
      reconnectTimer: null,
      backoffMs: reconnectBaseMs,
      reconnects: 0,
    }),
  );

  function openConnections(): number {
    return slots.filter((slot) => slot.open).length;
  }

  function safeSend(slot: ConnectionSlot, data: string): void {
    try {
      slot.socket?.send(data);
    } catch (error) {
      logJson("warn", "WS_SEND_FAILED", "polymarket_dualws_send_failed", {
        ...errorFields(error),
      });
    }
  }

  function disconnect(
    index: number,
    socket: ReturnType<MarketSocketFactory>,
  ): void {
    const slot = slots[index];
    if (slot === undefined || slot.socket !== socket) {
      return;
    }
    const wasOpen = slot.open;
    // Invalidate every callback before close(): a silent transport can omit
    // onClose, emit it later, or throw while closing.
    slot.open = false;
    slot.socket = null;
    if (slot.heartbeat !== null) {
      clearInterval(slot.heartbeat);
      slot.heartbeat = null;
    }
    if (closed) {
      return;
    }
    if (openConnections() > 0) {
      if (wasOpen) {
        singleConnectionDrops += 1;
      }
      logJson(
        "warn",
        "WS_SINGLE_CONNECTION_DOWN",
        "polymarket_dualws_one_connection_down",
        { connection: index },
      );
    } else if (bothDownSince === null) {
      bothDownSince = clock();
      bothDownEvents += 1;
      logJson(
        "error",
        "WS_BOTH_CONNECTIONS_DOWN",
        "polymarket_dualws_both_connections_down",
        { down_since: bothDownSince },
      );
      deps.onBothDown({ downSince: bothDownSince });
    }
    if (closed || slot.reconnectTimer !== null) {
      return;
    }
    const delay = slot.backoffMs;
    slot.backoffMs = Math.min(slot.backoffMs * 2, reconnectMaxMs);
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = null;
      if (closed) {
        return;
      }
      slot.reconnects += 1;
      connect(index);
    }, delay);
  }

  function retire(index: number): void {
    const socket = slots[index]?.socket;
    if (socket === undefined || socket === null) {
      return;
    }
    disconnect(index, socket);
    try {
      socket.close();
    } catch {
      // Recovery was scheduled before closing the transport.
    }
  }

  function connect(index: number): void {
    const slot = slots[index];
    if (slot === undefined || closed) {
      return;
    }
    const socket = deps.socketFactory(url);
    slot.socket = socket;
    slot.open = false;

    socket.onOpen(() => {
      if (closed || slot.socket !== socket || slot.open) {
        return;
      }
      slot.open = true;
      slot.backoffMs = reconnectBaseMs;
      bothDownSince = null;
      if (rollingSlot === index) {
        // The rolled slot is back with the new list in its opening frame; the
        // next resubscribe may roll again.
        rollingSlot = null;
      }
      safeSend(slot, subscribeMessage(tokenIds));
      slot.heartbeat = setInterval(() => {
        safeSend(slot, "PING");
      }, heartbeatMs);
    });

    socket.onMessage((raw) => {
      if (
        closed ||
        slot.socket !== socket ||
        !slot.open ||
        raw === "PING" ||
        raw === "PONG"
      ) {
        return;
      }
      const firstCopy = deduper.firstCopy(raw, clock());
      deps.onObservation?.(raw, firstCopy);
      if (firstCopy) {
        messagesForwarded += 1;
        deps.onMessage(raw);
      } else {
        duplicatesDropped += 1;
      }
    });

    socket.onClose(() => {
      disconnect(index, socket);
    });
  }

  for (let index = 0; index < CONNECTION_COUNT; index += 1) {
    connect(index);
  }

  /**
   * Cycle ONE slot: retire it and reconnect it with the new
   * token list. The twin stays up throughout, so `openConnections()` never
   * reaches zero and `onBothDown` never fires because of a resubscribe.
   *
   * Closing is what does the work — `connect()` subscribes on `open`, and the
   * venue only serves books for tokens named in that first frame.
   */
  function rollSlot(index: number): boolean {
    const slot = slots[index];
    if (slot === undefined || slot.socket === null || !slot.open) {
      return false;
    }
    // Never take the last open connection down for a resubscribe. Losing
    // redundancy is acceptable; losing the feed is a gap.
    if (openConnections() <= 1) {
      return false;
    }
    rollingSlot = index;
    // Reset the backoff: this close is deliberate, not a failure, so the
    // reconnect must not inherit a penalty from an earlier outage.
    slot.backoffMs = reconnectBaseMs;
    retire(index);
    return true;
  }

  return {
    resubscribe(nextTokenIds: readonly string[]): void {
      const previous = new Set(tokenIds);
      const entering = nextTokenIds.filter((id) => !previous.has(id));
      tokenIds = [...nextTokenIds];

      // Every live socket still gets the frame. It costs nothing, it keeps the
      // subscription list honest on the venue's side for tokens that were
      // already there, and — measured — it is simply ignored for new ones.
      for (const slot of slots) {
        if (slot.open) {
          safeSend(slot, subscribeMessage(tokenIds));
        }
      }

      if (entering.length === 0) {
        // Only removals: no new book is needed, so no socket is churned.
        resubscribesWithoutEntry += 1;
        return;
      }
      if (rollingSlot !== null) {
        // A roll is already in flight. Its reconnect will subscribe with the
        // list as it stands then, which already includes these tokens, so a
        // second roll would only pay another re-book for nothing.
        logJson(
          "info",
          "WS_ROLLING_RESUBSCRIBE_SKIPPED",
          "polymarket_dualws_rolling_resubscribe_in_flight",
          { entering: entering.length, slot: rollingSlot },
        );
        return;
      }
      // A slot that is NOT open needs no roll at all: whether it is waiting on
      // its backoff or mid-handshake, `connect`'s `onOpen` reads the CURRENT
      // token list, so it will subscribe with these tokens on its own. Closing
      // it would buy a wasted handshake, and reporting it as "deferred" would
      // tell the soak reader that the tokens are stuck when they are not.
      const reconnectingIndex = slots.findIndex((slot) => !slot.open);
      if (reconnectingIndex !== -1) {
        rollingResubscribes += 1;
        logJson(
          "info",
          "WS_ROLLING_RESUBSCRIBE_NOT_NEEDED",
          "polymarket_dualws_rolling_resubscribe_not_needed",
          {
            slot: reconnectingIndex,
            entering: entering.length,
            tokens: tokenIds.length,
            open_connections: openConnections(),
          },
        );
        return;
      }
      const target = 0;
      if (rollSlot(target)) {
        rollingResubscribes += 1;
        logJson(
          "info",
          "WS_ROLLING_RESUBSCRIBE",
          "polymarket_dualws_rolling_resubscribe",
          {
            slot: target,
            entering: entering.length,
            tokens: tokenIds.length,
            open_connections: openConnections(),
          },
        );
      } else {
        // Only one connection is up: rolling it would blind the recorder.
        // The tokens stay bookless until the next cycle, and the
        // `subscribe_book_missing` gap records exactly that.
        logJson(
          "warn",
          "WS_ROLLING_RESUBSCRIBE_DEFERRED",
          "polymarket_dualws_rolling_resubscribe_deferred",
          { entering: entering.length, open_connections: openConnections() },
        );
      }
    },
    reconnectSilent(): void {
      if (closed) {
        return;
      }
      rollingSlot = null;
      for (let index = 0; index < CONNECTION_COUNT; index += 1) {
        retire(index);
      }
    },
    close(): void {
      closed = true;
      rollingSlot = null;
      for (const slot of slots) {
        if (slot.heartbeat !== null) {
          clearInterval(slot.heartbeat);
          slot.heartbeat = null;
        }
        if (slot.reconnectTimer !== null) {
          clearTimeout(slot.reconnectTimer);
          slot.reconnectTimer = null;
        }
        try {
          slot.socket?.close();
        } catch {
          // Closing an already-dead socket must not throw.
        }
        slot.socket = null;
        slot.open = false;
      }
    },
    stats(): DualSocketStats {
      return {
        messagesForwarded,
        duplicatesDropped,
        singleConnectionDrops,
        bothDownEvents,
        reconnects: slots.map((slot) => slot.reconnects),
        openConnections: openConnections(),
        rollingResubscribes,
        resubscribesWithoutEntry,
      };
    },
  };
}
