import { createHash } from "node:crypto";

import {
  MARKET_WS_URL,
  subscribeMessage,
  type MarketSocketFactory,
} from "./recorder.js";

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
}

export interface DualMarketSocket {
  /** Swap the subscribed universe without tearing the connections down: a
   * fresh subscribe frame is sent on each live socket, and reconnects use the
   * new list. (If the venue ever requires a fresh socket per subscription,
   * close/reopen here instead — the contract to callers stays the same.) */
  resubscribe(tokenIds: readonly string[]): void;
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
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
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
      if (closed || slot.socket !== socket) {
        return;
      }
      slot.open = true;
      slot.backoffMs = reconnectBaseMs;
      bothDownSince = null;
      safeSend(slot, subscribeMessage(tokenIds));
      slot.heartbeat = setInterval(() => {
        safeSend(slot, "PING");
      }, heartbeatMs);
    });

    socket.onMessage((raw) => {
      if (closed || raw === "PONG") {
        return;
      }
      if (deduper.firstCopy(raw, clock())) {
        messagesForwarded += 1;
        deps.onMessage(raw);
      } else {
        duplicatesDropped += 1;
      }
    });

    socket.onClose(() => {
      if (slot.socket !== socket) {
        return;
      }
      const wasOpen = slot.open;
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
        // The twin is still delivering: redundancy lost, but no gap.
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
      const delay = slot.backoffMs;
      slot.backoffMs = Math.min(slot.backoffMs * 2, reconnectMaxMs);
      slot.reconnectTimer = setTimeout(() => {
        slot.reconnectTimer = null;
        slot.reconnects += 1;
        connect(index);
      }, delay);
    });
  }

  for (let index = 0; index < CONNECTION_COUNT; index += 1) {
    connect(index);
  }

  return {
    resubscribe(nextTokenIds: readonly string[]): void {
      tokenIds = [...nextTokenIds];
      for (const slot of slots) {
        if (slot.open) {
          safeSend(slot, subscribeMessage(tokenIds));
        }
      }
    },
    close(): void {
      closed = true;
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
      };
    },
  };
}
