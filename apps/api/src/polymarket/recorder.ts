import { WebSocket } from "ws";

import type { DatabasePool } from "../database.js";
import { OrderBook } from "./book.js";
import { isInUniverse, parseMarket } from "./gamma.js";
import { parseMarketFrame } from "./messages.js";
import { applyMarketMetadataObservation } from "./registry.js";
import type {
  MarketMessage,
  MarketRegistryEntry,
  PriceLevel,
} from "./types.js";

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 3_000;
export const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
export const MARKET_WS_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// Polymarket sits behind Cloudflare, which rejects non-browser-like clients;
// send a User-Agent (and Origin for the socket) so requests are accepted.
const USER_AGENT = "GansoMarketRecorder/1.0 (+public-data-recorder)";
const WEB_ORIGIN = "https://polymarket.com";

export interface BookSnapshot {
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly sourceTs: string | null;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

export interface RecorderStore {
  upsertMarket(entry: MarketRegistryEntry): Promise<void>;
  insertSnapshot(snapshot: BookSnapshot): Promise<void>;
}

// Persists at most one snapshot per token per interval (top-of-book every few
// seconds, not on every delta).
export class SnapshotThrottle {
  readonly #last = new Map<string, number>();
  readonly #intervalMs: number;

  public constructor(intervalMs: number = DEFAULT_SNAPSHOT_INTERVAL_MS) {
    this.#intervalMs = intervalMs;
  }

  public shouldPersist(tokenId: string, nowMs: number): boolean {
    const last = this.#last.get(tokenId);
    if (last === undefined || nowMs - last >= this.#intervalMs) {
      this.#last.set(tokenId, nowMs);
      return true;
    }
    return false;
  }
}

// Maintains a live order book per token from WebSocket messages and persists
// throttled top-10 snapshots. Transport-agnostic and unit-testable.
export class MarketBookTracker {
  readonly #books = new Map<string, OrderBook>();
  readonly #store: RecorderStore;
  readonly #throttle: SnapshotThrottle;
  readonly #clock: () => number;

  public constructor(
    store: RecorderStore,
    throttle: SnapshotThrottle,
    clock: () => number,
  ) {
    this.#store = store;
    this.#throttle = throttle;
    this.#clock = clock;
  }

  public async handle(message: MarketMessage): Promise<void> {
    if (message.event_type === "book") {
      this.#books.set(message.asset_id, OrderBook.fromMessage(message));
      await this.maybePersist(
        message.asset_id,
        message.market,
        message.timestamp,
      );
      return;
    }
    if (message.event_type === "price_change") {
      const touched = new Set<string>();
      for (const change of message.price_changes) {
        const book = this.#books.get(change.asset_id);
        if (book !== undefined) {
          book.applyPriceChange(change);
          touched.add(change.asset_id);
        }
      }
      for (const tokenId of touched) {
        await this.maybePersist(tokenId, message.market, message.timestamp);
      }
    }
    // last_trade_price and tick_size_change do not change book depth here.
  }

  private async maybePersist(
    tokenId: string,
    conditionId: string,
    sourceTs: string | null,
  ): Promise<void> {
    const book = this.#books.get(tokenId);
    if (book === undefined) {
      return;
    }
    if (!this.#throttle.shouldPersist(tokenId, this.#clock())) {
      return;
    }
    await this.#store.insertSnapshot({
      tokenId,
      conditionId,
      sourceTs,
      bids: book.topBids(),
      asks: book.topAsks(),
    });
  }
}

type JsonFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Fetch and filter the tracked-universe markets from the public Gamma API. */
export async function fetchTrackedMarkets(
  fetcher: JsonFetcher = fetch,
  baseUrl: string = GAMMA_BASE_URL,
): Promise<MarketRegistryEntry[]> {
  // Order by 24h volume and include tags so the tracked-category filter has real
  // tags to work with (Gamma's default ordering returns mostly election markets).
  const url =
    `${baseUrl}/markets?closed=false&active=true` +
    `&order=volume24hr&ascending=false&limit=200&include_tag=true&related_tags=true`;
  const response = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  });
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as unknown;
  const rows = Array.isArray(body) ? body : [];
  const entries: MarketRegistryEntry[] = [];
  for (const row of rows) {
    const entry = parseMarket(row);
    if (entry !== null && isInUniverse(entry)) {
      entries.push(entry);
    }
  }
  return entries;
}

export interface MarketSocket {
  onOpen(handler: () => void): void;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: () => void): void;
  send(data: string): void;
  close(): void;
}

export type MarketSocketFactory = (url: string) => MarketSocket;

/** Adapter over the `ws` client, which (unlike the global WebSocket) can send
 * the browser-like headers Polymarket's Cloudflare edge requires. */
export function nodeMarketSocketFactory(url: string): MarketSocket {
  const socket = new WebSocket(url, {
    headers: { "User-Agent": USER_AGENT, Origin: WEB_ORIGIN },
  });
  // Without an error listener the ws client throws "Unhandled 'error' event"
  // and kills the process (seen live: transient DNS EAI_AGAIN). The library
  // emits 'close' right after 'error', so the caller's reconnect logic runs.
  socket.on("error", (error: Error) => {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        service: "polymarket-recorder",
        timestamp: new Date().toISOString(),
        reason_code: "WS_SOCKET_ERROR",
        error_name: error.name,
        message: "polymarket_ws_socket_error",
      })}\n`,
    );
  });
  return {
    onOpen(handler): void {
      socket.on("open", () => {
        handler();
      });
    },
    onMessage(handler): void {
      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        handler(data.toString());
      });
    },
    onClose(handler): void {
      socket.on("close", () => {
        handler();
      });
    },
    send(data): void {
      socket.send(data);
    },
    close(): void {
      socket.close();
    },
  };
}

export function subscribeMessage(tokenIds: readonly string[]): string {
  return JSON.stringify({ assets_ids: tokenIds, type: "market" });
}

// Polymarket sends timestamps as epoch milliseconds in a string; TIMESTAMPTZ
// rejects that literal, so convert before persisting. Anything else becomes
// null (the row still gets received_at locally).
export function sourceTsToDate(sourceTs: string | null): Date | null {
  if (sourceTs === null || !/^\d{1,15}$/.test(sourceTs)) {
    return null;
  }
  return new Date(Number(sourceTs));
}

/** PostgreSQL persistence for the recorder (public data only). */
export function createPostgresRecorderStore(pool: DatabasePool): RecorderStore {
  return {
    async upsertMarket(entry: MarketRegistryEntry): Promise<void> {
      const observedAt = new Date();
      await pool.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO polymarket_markets
           (condition_id, question, slug, category, neg_risk, clob_token_ids,
            affirmative_token_id, rules, tick_size, min_order_size,
            rewards_min_size, rewards_max_spread, fee_type, end_date_iso,
            active, closed, received_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
         ON CONFLICT (condition_id) DO UPDATE SET
           question = EXCLUDED.question,
           slug = EXCLUDED.slug,
           category = EXCLUDED.category,
           neg_risk = EXCLUDED.neg_risk,
           clob_token_ids = EXCLUDED.clob_token_ids,
           affirmative_token_id = EXCLUDED.affirmative_token_id,
           rules = EXCLUDED.rules,
           rules_version = polymarket_markets.rules_version
             + CASE WHEN polymarket_markets.rules IS DISTINCT FROM EXCLUDED.rules THEN 1 ELSE 0 END,
           tick_size = EXCLUDED.tick_size,
           min_order_size = EXCLUDED.min_order_size,
           rewards_min_size = EXCLUDED.rewards_min_size,
           rewards_max_spread = EXCLUDED.rewards_max_spread,
           fee_type = EXCLUDED.fee_type,
           end_date_iso = EXCLUDED.end_date_iso,
           active = EXCLUDED.active,
           closed = EXCLUDED.closed,
           updated_at = EXCLUDED.updated_at`,
          [
            entry.conditionId,
            entry.question,
            entry.slug,
            entry.category,
            entry.negRisk,
            JSON.stringify(entry.clobTokenIds),
            entry.affirmativeTokenId,
            entry.rules,
            entry.tickSize,
            entry.minOrderSize,
            entry.rewardsMinSize,
            entry.rewardsMaxSpread,
            entry.feeType,
            entry.endDateIso,
            entry.active,
            entry.closed,
            observedAt,
          ],
        );
        await applyMarketMetadataObservation(
          tx,
          {
            conditionId: entry.conditionId,
            question: entry.question,
            category: entry.category,
            clobTokenIds: entry.clobTokenIds,
            affirmativeTokenId: entry.affirmativeTokenId,
            sourceTs: null,
          },
          observedAt,
        );
      });
    },
    async insertSnapshot(snapshot: BookSnapshot): Promise<void> {
      await pool.query(
        `INSERT INTO polymarket_book_snapshots
           (token_id, condition_id, source_ts, bids_json, asks_json)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [
          snapshot.tokenId,
          snapshot.conditionId,
          sourceTsToDate(snapshot.sourceTs),
          JSON.stringify(snapshot.bids),
          JSON.stringify(snapshot.asks),
        ],
      );
    },
  };
}

export interface RecorderConfig {
  readonly store: RecorderStore;
  readonly socketFactory?: MarketSocketFactory;
  readonly fetcher?: JsonFetcher;
  readonly snapshotIntervalMs?: number;
}

/**
 * Wire the live recorder: poll Gamma for the tracked universe, subscribe to the
 * market WebSocket for those token ids, and persist throttled snapshots. The
 * caller owns the process lifetime; this resolves only if the socket closes.
 */
export async function runRecorder(config: RecorderConfig): Promise<void> {
  const socketFactory = config.socketFactory ?? nodeMarketSocketFactory;
  const fetcher = config.fetcher ?? fetch;
  const throttle = new SnapshotThrottle(config.snapshotIntervalMs);
  const tracker = new MarketBookTracker(config.store, throttle, () =>
    Date.now(),
  );

  const markets = await fetchTrackedMarkets(fetcher);
  for (const market of markets) {
    await config.store.upsertMarket(market);
  }
  const tokenIds = markets.flatMap((market) => [...market.clobTokenIds]);

  await new Promise<void>((resolve) => {
    const socket = socketFactory(MARKET_WS_URL);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    socket.onOpen(() => {
      // Subscribe only once the socket is open, then keep it alive with a
      // client heartbeat every 10s.
      socket.send(subscribeMessage(tokenIds));
      heartbeat = setInterval(() => {
        socket.send("PING");
      }, 10_000);
    });
    socket.onMessage((raw) => {
      if (raw === "PONG") {
        return;
      }
      for (const message of parseMarketFrame(raw)) {
        // A persistence failure must not become an unhandled rejection that
        // kills the process: log it and close the socket so the caller's
        // reconnect loop retries with a fresh book.
        tracker.handle(message).catch((error: unknown) => {
          process.stderr.write(
            `${JSON.stringify({
              level: "error",
              service: "polymarket-recorder",
              timestamp: new Date().toISOString(),
              reason_code: "SNAPSHOT_PERSIST_FAILED",
              error_name: error instanceof Error ? error.name : "UnknownError",
              message: "polymarket_recorder_persist_failed",
            })}\n`,
          );
          socket.close();
        });
      }
    });
    socket.onClose(() => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      resolve();
    });
  });
}
