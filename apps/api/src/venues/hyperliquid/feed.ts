import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  L2BookRequest,
  TradesRequest,
  ActiveAssetCtxRequest,
} from "@nktkas/hyperliquid/api/subscription";
import type {
  TradingInstrumentMetadata,
  TradingMarketObservation,
  TradingMarketData,
} from "@ganso-market/contracts/trading";
import { FeedQualityMachine, type FeedChannel } from "../../trading/feed.js";
import {
  HYPERLIQUID_FEED_LIMITS as limits,
  WIRE_CHANNELS,
  normalizeHyperliquidFeed,
} from "./feed-normalizer.js";

const URL = "wss://api.hyperliquid.xyz/ws";
const subscriptions = [
  { type: "l2Book", coin: "BTC" },
  { type: "trades", coin: "BTC" },
  { type: "activeAssetCtx", coin: "BTC" },
] satisfies (L2BookRequest | TradesRequest | ActiveAssetCtxRequest)[];

/** Explicit opt-in only: not imported by server/worker. Public socket, no storage,
 * credentials, environment, execution client or unbounded retry/outbound queue.
 * ws is already installed; SDK 0.33.3's transport does not expose maxPayload.
 * https://github.com/nktkas/hyperliquid/blob/v0.33.3/src/transport/websocket/mod.ts
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats
 */
export function startHyperliquidBtcFeed(metadata: TradingInstrumentMetadata) {
  if (
    metadata.instrument.instrument_id !== "hyperliquid:mainnet:BTC" ||
    metadata.instrument.venue_symbol !== "BTC"
  )
    throw new TypeError("Expected standard BTC metadata");
  const machine = new FeedQualityMachine<TradingMarketObservation>();
  const session = randomUUID();
  let observation = 0;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let stopped = false;
  let terminalReason: string | null = null;
  let openedAt = 0;
  let lastPing = 0;
  let waitingPongAt: number | null = null;
  let acked = new Set<string>();
  function send(message: unknown) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > limits.outboundBytes) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(message)); // At most 3 subscriptions and one outstanding ping.
  }
  function stop(reason = "stopped") {
    if (stopped) return;
    stopped = true;
    terminalReason = reason;
    clearTimeout(retryTimer);
    clearInterval(watchdog);
    machine.disconnect(Date.now());
    socket?.terminate();
  }
  function connect() {
    if (stopped) return;
    acked = new Set();
    waitingPongAt = null;
    const current = new WebSocket(URL, {
      maxPayload: limits.maxPayloadBytes,
      handshakeTimeout: limits.handshakeMs,
      perMessageDeflate: false,
      followRedirects: false,
    });
    socket = current;
    current.on("open", () => {
      if (stopped || current !== socket) return;
      openedAt = Date.now();
      lastPing = openedAt;
      machine.open(openedAt);
      for (const subscription of subscriptions)
        send({ method: "subscribe", subscription });
    });
    current.on("message", (raw, binary) => {
      if (stopped || current !== socket) return;
      const now = Date.now();
      machine.message(now);
      let channel: FeedChannel | null = null;
      try {
        if (
          binary ||
          !Buffer.isBuffer(raw) ||
          raw.length > limits.maxPayloadBytes
        )
          throw new TypeError("Invalid frame");
        const frame = JSON.parse(raw.toString());
        if (
          !frame ||
          typeof frame !== "object" ||
          typeof frame.channel !== "string"
        )
          throw new TypeError("Invalid envelope");
        if (frame.channel === "pong") {
          waitingPongAt = null;
          return;
        }
        if (frame.channel === "subscriptionResponse") {
          const sub = frame.data?.subscription;
          if (
            frame.data?.method !== "subscribe" ||
            sub?.coin !== "BTC" ||
            !subscriptions.some((item) => item.type === sub.type)
          )
            throw new TypeError("Invalid subscription ack");
          acked.add(sub.type);
          return;
        }
        if (!Object.hasOwn(WIRE_CHANNELS, frame.channel))
          throw new TypeError("Unexpected public channel");
        channel = WIRE_CHANNELS[frame.channel as keyof typeof WIRE_CHANNELS];
        const events = normalizeHyperliquidFeed(
          channel,
          frame.data,
          new Date(now).toISOString(),
          metadata.instrument.instrument_version,
          `${session}:${++observation}`,
        );
        for (const event of events) machine.accept(event);
      } catch {
        if (channel) machine.invalid(channel, now);
        else
          for (const item of Object.values(WIRE_CHANNELS))
            machine.invalid(item, now);
        // Incompatible or oversized frames cannot be silently ignored as continuity.
        current.terminate();
      }
    });
    current.on("error", () => {
      /* close drives bounded retry; no raw payload logging */
    });
    current.on("close", () => {
      if (current !== socket || stopped) return;
      machine.disconnect(Date.now());
      if (retries >= limits.maxRetries) {
        stop("retries_exhausted");
        return;
      }
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 4000));
    });
  }
  const watchdog = setInterval(() => {
    if (stopped || socket?.readyState !== WebSocket.OPEN) return;
    const now = Date.now(),
      state = machine.status(now);
    if (
      (acked.size !== subscriptions.length &&
        now - openedAt >= limits.handshakeMs) ||
      (waitingPongAt !== null && now - waitingPongAt >= limits.pongTimeoutMs) ||
      state.channels.book.status === "stale" ||
      state.channels.context.status === "stale"
    ) {
      socket.terminate();
      return;
    }
    // Trade silence alone is uncertain activity, not proof of a dead channel/socket.
    if (waitingPongAt === null && now - lastPing >= limits.heartbeatMs) {
      waitingPongAt = now;
      lastPing = now;
      send({ method: "ping" });
    }
  }, 1000);
  connect();
  return {
    stop: () => stop(),
    drain: (): TradingMarketData[] => machine.drain(Date.now()),
    status: () => ({
      ...machine.status(Date.now()),
      retries,
      stopped,
      terminal_reason: terminalReason,
      subscriptions_confirmed: acked.size,
      transport_limits: limits,
    }),
  };
}
