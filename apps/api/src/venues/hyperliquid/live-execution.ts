import type {
  JevScope,
  TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import {
  assertInstrumentOrderConstraints,
  parseTradingAmount,
} from "@ganso-market/contracts/trading";
import type { LiveStore, LiveLease } from "../../storage/jev-live-store.js";
import { jevHash } from "../../storage/jev-hash.js";
import { sizeJevEntry, type JevEntryPlan } from "../../storage/jev-sizing.js";
import type { JevManifest } from "../../storage/jev-manifest.js";
import type { JevProtection } from "../../storage/jev-protection.js";
import { quoteJevMaker } from "../../storage/jev-execution-contract.js";
import { venueGridPrice } from "../../trading/price-grid.js";
import {
  liveCheck,
  liveDecimal,
  liveInteger,
  liveRecord,
  LiveError,
  type LiveIdentity,
  type LiveReservation,
} from "./live-contract.js";
import {
  requireLiveFreshSnapshot,
  type LiveSnapshot,
} from "./live-reconcile.js";

export const LIVE_COMMAND_VERSION = "hyperliquid.live-command.v1" as const;
type Base = {
  version: typeof LIVE_COMMAND_VERSION;
  scope: JevScope;
  operation_id: string;
  metadata: TradingInstrumentMetadata;
  metadata_at: number;
};
export type LiveCommand = Base &
  (
    | {
        kind: "entry";
        plan: JevEntryPlan;
        manifest: JevManifest;
        snapshot: LiveSnapshot;
        book: { bid_raw: string; ask_raw: string; received_at: number };
      }
    | {
        kind: "close";
        snapshot: LiveSnapshot;
        limit_price_raw: string;
        cause: string;
      }
    | { kind: "stop"; snapshot: LiveSnapshot; protection: JevProtection }
    | {
        kind: "cancel";
        target_operation_id: string;
        target_cloid: `0x${string}`;
      }
  );
export interface LiveReceipt {
  operation_id: string;
  kind: LiveReservation["kind"];
  observed_at: number;
  state:
    | "acknowledged"
    | "rejected"
    | "uncertain"
    | "open"
    | "filled"
    | "cancelled"
    | "triggered";
  oid: number | null;
  original: unknown;
}
function amount<U extends "BTC" | "USD_PER_BTC">(raw: string, unit: U) {
  return parseTradingAmount(unit, {
    unit,
    decimals: unit === "BTC" ? 8 : 6,
    raw,
  });
}
/** Reduced orders still obey venue precision. A residual below the entry minimum
 * is sent as a reduce-only attempt; its rejection leaves the position pending.
 * It must never be rounded UP or silently dropped as a completed close. */
function reducedConstraints(
  m: TradingInstrumentMetadata,
  price: string,
  quantity: string,
) {
  assertInstrumentOrderConstraints(
    {
      ...m,
      minimum_order_notional: {
        ...m.minimum_order_notional,
        raw: "1" as typeof m.minimum_order_notional.raw,
      },
    },
    amount(price, "USD_PER_BTC"),
    amount(quantity, "BTC"),
  );
}
export function buildLiveAction(
  identity: LiveIdentity,
  c: LiveCommand,
  cloid: `0x${string}`,
  now: number,
): Record<string, unknown> {
  liveCheck(
    c.version === LIVE_COMMAND_VERSION &&
      c.scope.mode === "live" &&
      c.scope.owner_id === identity.owner_id &&
      c.scope.account_id === identity.account_id &&
      c.scope.instrument_id === `hyperliquid:${identity.environment}:BTC`,
    "COMMAND_OWNER",
  );
  const fields = {
    entry:
      "book,kind,manifest,metadata,metadata_at,operation_id,plan,scope,snapshot,version",
    close:
      "cause,kind,limit_price_raw,metadata,metadata_at,operation_id,scope,snapshot,version",
    stop: "kind,metadata,metadata_at,operation_id,protection,scope,snapshot,version",
    cancel:
      "kind,metadata,metadata_at,operation_id,scope,target_cloid,target_operation_id,version",
  };
  liveCheck(Object.keys(c).sort().join() === fields[c.kind], "COMMAND_FIELDS");
  liveCheck(
    c.metadata.instrument.instrument_id === c.scope.instrument_id &&
      c.metadata.instrument.instrument_version === c.scope.instrument_version &&
      Number.isSafeInteger(c.metadata.venue_asset_index),
    "METADATA_OWNER",
  );
  liveCheck(
    c.metadata.venue_asset_index >= 0 &&
      c.metadata.instrument.origin.source_id ===
        `hyperliquid:${identity.environment}:meta-observation` &&
      Date.parse(c.metadata.instrument.origin.received_at) === c.metadata_at,
    "METADATA_PROVENANCE",
  );
  liveCheck(
    c.metadata_at <= now && now - c.metadata_at <= 2000,
    "METADATA_STALE",
  );
  const asset = c.metadata.venue_asset_index;
  if (c.kind === "cancel") {
    liveCheck(/^0x[a-f0-9]{32}$/.test(c.target_cloid), "CANCEL_TARGET");
    return {
      type: "cancelByCloid",
      cancels: [{ asset, cloid: c.target_cloid }],
    };
  }
  requireLiveFreshSnapshot(identity, c.snapshot, now);
  const pos = BigInt(c.snapshot.position_raw);
  let buy: boolean, quantity: string, price: string, orderType: unknown;
  if (c.kind === "entry") {
    const p = c.plan;
    liveCheck(
      c.snapshot.flat &&
        c.snapshot.history_complete &&
        c.snapshot.isolated_1x &&
        pos === 0n &&
        c.snapshot.orders.length === 0,
      "ENTRY_RECONCILIATION",
    );
    const decisionAt = Date.parse(p.input.decision_at);
    liveCheck(
      jevHash(p.input.scope) === jevHash(c.scope) &&
        decisionAt <= now &&
        now - decisionAt <= c.manifest.freshness.decision_ttl_ms &&
        c.book.received_at <= now &&
        now - c.book.received_at <= 2000,
      "DECISION_OR_BOOK_STALE",
    );
    liveCheck(
      p.equity_usd_raw === c.snapshot.equity_raw &&
        jevHash(
          sizeJevEntry(c.manifest, c.metadata, p.input, p.equity_usd_raw),
        ) === jevHash(p),
      "ENTRY_PLAN",
    );
    buy = p.input.direction === "long";
    price = quoteJevMaker(
      buy ? "buy" : "sell",
      c.book.bid_raw,
      c.book.ask_raw,
      c.metadata,
    );
    quantity = p.quantity_btc_raw;
    liveCheck(price === p.input.entry_price_raw, "ENTRY_PRICE_CHANGED");
    assertInstrumentOrderConstraints(
      c.metadata,
      amount(price, "USD_PER_BTC"),
      amount(quantity, "BTC"),
    );
    orderType = { limit: { tif: "Alo" } };
  } else {
    liveCheck(pos !== 0n, "NO_POSITION");
    buy = pos < 0n;
    quantity = (pos < 0n ? -pos : pos).toString();
    if (c.kind === "close") {
      liveCheck(
        typeof c.cause === "string" &&
          c.cause.length > 0 &&
          c.cause.length <= 160,
        "CLOSE_CAUSE",
      );
      price = c.limit_price_raw;
      orderType = { limit: { tif: "Ioc" } };
    } else {
      const p = c.protection;
      liveCheck(
        jevHash(p.scope) === jevHash(c.scope) &&
          (p.direction === "short") === buy &&
          p.quantity_btc_raw === quantity,
        "STOP_OWNER_OR_QUANTITY",
      );
      const stop = BigInt(p.stop_price_raw);
      const worst = venueGridPrice(
        stop * (buy ? 11n : 9n),
        10n,
        buy ? "up" : "down",
        c.metadata,
      );
      liveCheck(worst !== null && worst > 0n, "STOP_GRID");
      price = worst.toString();
      reducedConstraints(c.metadata, p.stop_price_raw, quantity);
      orderType = {
        trigger: {
          isMarket: true,
          triggerPx: liveDecimal(p.stop_price_raw, 6),
          tpsl: "sl",
        },
      };
    }
    reducedConstraints(c.metadata, price, quantity);
  }
  return {
    type: "order",
    orders: [
      {
        a: asset,
        b: buy,
        p: liveDecimal(price, 6),
        s: liveDecimal(quantity, 8),
        r: c.kind !== "entry",
        t: orderType,
        c: cloid,
      },
    ],
    grouping: c.kind === "stop" ? "positionTpsl" : "na",
  };
}
/** ACKs are protocol receipts, never accounting fills. Global pre-validation
 * rejection is distinct from a vector containing partial per-order errors. */
export function parseLiveBatchReceipt(
  value: unknown,
  expected: number,
): Array<{
  state: LiveReceipt["state"];
  oid: number | null;
  original: unknown;
}> {
  liveInteger(expected, 1);
  const outer = liveRecord(value);
  if (outer.status === "err")
    return Array.from({ length: expected }, () => ({
      state: "rejected",
      oid: null,
      original: value,
    }));
  liveCheck(outer.status === "ok", "RECEIPT_STATUS");
  const response = liveRecord(outer.response),
    data = liveRecord(response.data);
  liveCheck(
    (response.type === "order" || response.type === "cancel") &&
      Array.isArray(data.statuses) &&
      data.statuses.length === expected,
    "RECEIPT_VECTOR",
  );
  return data.statuses.map((x) => {
    if (x === "success" || x === "waitingForTrigger" || x === "waitingForFill")
      return { state: "acknowledged", oid: null, original: x };
    const r = liveRecord(x);
    if (typeof r.error === "string" && Object.keys(r).length === 1)
      return { state: "rejected", oid: null, original: x };
    liveCheck(
      Object.keys(r).length === 1 && (r.resting || r.filled),
      "RECEIPT_ORDER",
    );
    const order = liveRecord(r.resting ?? r.filled);
    // A 'filled' ACK still awaits the authoritative userFills/account snapshot.
    return {
      state: "acknowledged",
      oid: liveInteger(order.oid, 1),
      original: x,
    };
  });
}
type Boundary = {
  submit(r: LiveReservation): Promise<unknown>;
  info(type: "orderStatus", params: Record<string, unknown>): Promise<unknown>;
};
export class LiveExecution {
  constructor(
    readonly store: LiveStore,
    readonly boundary: Boundary,
    readonly clock: () => number = Date.now,
  ) {}
  /** Repeated protective intent queries the immutable request; new evidence
   * cannot be substituted into an old nonce. */
  async protectOnce(c: LiveCommand, lease: LiveLease) {
    const previous = (await this.store.operations()).find(
      (r) => r.operation_id === c.operation_id,
    );
    if (previous) {
      liveCheck(
        previous.kind === c.kind &&
          jevHash(previous.scope) === jevHash(c.scope),
        "IDEMPOTENCY_COLLISION",
      );
      return this.recover(previous);
    }
    return this.execute(c, lease);
  }
  async executeResidual(
    c: Extract<LiveCommand, { kind: "close" }>,
    lease: LiveLease,
  ) {
    const receipts = await this.store.events<LiveReceipt>("receipt");
    const requests = (await this.store.operations()).filter(
      (r) => r.kind === "close" && jevHash(r.scope) === jevHash(c.scope),
    );
    const unresolved = requests.find(
      (r) =>
        r.kind === "close" &&
        jevHash(r.scope) === jevHash(c.scope) &&
        !["filled", "cancelled", "rejected"].includes(
          receipts.filter((e) => e.operation_id === r.operation_id).at(-1)
            ?.state ?? "uncertain",
        ),
    );
    if (unresolved) return this.recover(unresolved);
    const previous = requests.at(-1);
    const terminal = previous
      ? receipts.filter((e) => e.operation_id === previous.operation_id).at(-1)
      : null;
    if (
      previous &&
      terminal &&
      ((previous.request as Extract<LiveCommand, { kind: "close" }>).snapshot
        .snapshot_id === c.snapshot.snapshot_id ||
        terminal.observed_at > c.snapshot.venue_at)
    )
      return terminal;
    return this.protectOnce(c, lease);
  }
  async cancelEntry(
    entry: LiveReservation,
    lease: LiveLease,
    metadata: TradingInstrumentMetadata,
    metadataAt = Date.parse(metadata.instrument.origin.received_at),
  ) {
    liveCheck(entry.kind === "entry", "MAKER_OWNER");
    return this.cancelOrder(entry, lease, metadata, metadataAt);
  }
  async cancelOrder(
    entry: LiveReservation,
    lease: LiveLease,
    metadata: TradingInstrumentMetadata,
    metadataAt = Date.parse(metadata.instrument.origin.received_at),
  ) {
    liveCheck(entry.kind === "entry" || entry.kind === "stop", "CANCEL_OWNER");
    const previous = (await this.store.operations())
      .filter(
        (r) =>
          r.kind === "cancel" &&
          (r.request as Extract<LiveCommand, { kind: "cancel" }>)
            .target_operation_id === entry.operation_id &&
          jevHash(r.scope) === jevHash(entry.scope),
      )
      .at(-1);
    let operation_id = `cancel:${jevHash(entry.operation_id)}`;
    if (previous) {
      const { snapshot } = await this.store.latest();
      const oids = (await this.store.events<LiveReceipt>("receipt"))
        .filter((r) => r.operation_id === entry.operation_id && r.oid !== null)
        .map((r) => r.oid);
      // A new cancellation needs a fresh query proving the parent still open
      // after the old intent's venue expiry. Never replay its nonce/signature,
      // and never create another entry to resolve an uncertain cancellation.
      if (
        !snapshot ||
        snapshot.venue_at <= previous.expires_after ||
        !snapshot.orders.some(
          (o) => o.cloid === entry.cloid || oids.includes(o.oid),
        )
      )
        return this.recover(previous);
      requireLiveFreshSnapshot(this.store.identity, snapshot, this.clock());
      operation_id += `:${jevHash([previous.operation_id, snapshot.snapshot_id])}`;
    }
    return this.protectOnce(
      {
        version: LIVE_COMMAND_VERSION,
        kind: "cancel",
        scope: entry.scope,
        operation_id,
        metadata,
        metadata_at: metadataAt,
        target_operation_id: entry.operation_id,
        target_cloid: entry.cloid,
      },
      lease,
    );
  }
  async recover(r: LiveReservation): Promise<LiveReceipt> {
    if (r.expires_after <= this.clock() && this.store.expiredUnsent) {
      const unsent = await this.store.expiredUnsent(r);
      if (unsent) return unsent;
    }
    let receipt: LiveReceipt;
    try {
      const oid =
        r.kind === "cancel"
          ? (r.request as LiveCommand & { target_cloid: string }).target_cloid
          : r.cloid;
      const result = await this.boundary.info("orderStatus", { oid }),
        x = liveRecord(result);
      liveCheck(x.status === "order", "ORDER_UNKNOWN");
      const order = liveRecord(x.order),
        inner = liveRecord(order.order);
      liveCheck(inner.cloid === oid && inner.coin === "BTC", "RECEIPT_OWNER");
      const status = order.status;
      const state =
        status === "open"
          ? "open"
          : status === "filled"
            ? "filled"
            : status === "triggered"
              ? "triggered"
              : (typeof status === "string" && status.endsWith("Canceled")) ||
                  status === "canceled"
                ? "cancelled"
                : (typeof status === "string" && status.endsWith("Rejected")) ||
                    status === "rejected"
                  ? "rejected"
                  : "uncertain";
      receipt = {
        operation_id: r.operation_id,
        kind: r.kind,
        observed_at: this.clock(),
        state,
        oid: liveInteger(inner.oid, 1),
        original: result,
      };
    } catch {
      receipt = {
        operation_id: r.operation_id,
        kind: r.kind,
        observed_at: this.clock(),
        state: "uncertain",
        oid: null,
        original: { reason: "ORDER_STATUS_UNKNOWN" },
      };
    }
    await this.store.append(
      "receipt",
      `receipt:query:${r.operation_id}:${jevHash(receipt)}`,
      receipt,
    );
    return receipt;
  }
  async execute(c: LiveCommand, lease: LiveLease): Promise<LiveReceipt> {
    // Replay uses the already reserved intent, including its original evidence.
    // Even after an uncertain send, a nonce/cloid is never re-signed or resent.
    const previous = (await this.store.operations()).find(
      (r) => r.operation_id === c.operation_id,
    );
    if (previous) {
      liveCheck(
        jevHash(previous.request) === jevHash(c),
        "IDEMPOTENCY_COLLISION",
      );
      return this.recover(previous);
    }
    const now = this.clock();
    if (c.kind === "cancel") {
      const target = (await this.store.operations()).find(
        (r) => r.operation_id === c.target_operation_id,
      );
      liveCheck(
        (target?.kind === "entry" || target?.kind === "stop") &&
          target.cloid === c.target_cloid &&
          jevHash(target.scope) === jevHash(c.scope),
        "CANCEL_OWNER",
      );
    }
    const action = (cloid: `0x${string}`) =>
      buildLiveAction(this.store.identity, c, cloid, now);
    const reserved = await this.store.reserve({
      scope: c.scope,
      operation_id: c.operation_id,
      kind: c.kind,
      request: structuredClone(c),
      action,
      lease,
    });
    if (!reserved.fresh) return this.recover(reserved.reservation);
    let receipt: LiveReceipt;
    try {
      const original = await this.boundary.submit(reserved.reservation);
      const item = parseLiveBatchReceipt(original, 1)[0]!;
      receipt = {
        ...item,
        original,
        operation_id: c.operation_id,
        kind: c.kind,
        observed_at: this.clock(),
      };
    } catch (e) {
      receipt = {
        operation_id: c.operation_id,
        kind: c.kind,
        observed_at: this.clock(),
        state: "uncertain",
        oid: null,
        original: {
          reason: e instanceof LiveError ? e.code : "RECEIPT_UNKNOWN",
        },
      };
    }
    await this.store.append(
      "receipt",
      `receipt:send:${c.operation_id}`,
      receipt,
    );
    return receipt;
  }
  /** Call after a reconciliation. The two-second maker window starts at ACK;
   * ACK loss causes a query, and cancellation never manufactures a flat result. */
  async cancelExpired(
    entry: LiveReservation,
    receipts: LiveReceipt[],
    lease: LiveLease,
    metadata: TradingInstrumentMetadata,
    metadataAt: number,
  ) {
    liveCheck(entry.kind === "entry", "MAKER_OWNER");
    const ack = receipts.find(
      (r) =>
        r.operation_id === entry.operation_id &&
        r.kind === "entry" &&
        ["acknowledged", "open"].includes(r.state),
    );
    if (!ack) {
      await this.recover(entry);
      return null;
    }
    if (this.clock() < ack.observed_at + 2000) return null;
    return this.cancelEntry(entry, lease, metadata, metadataAt);
  }
}
