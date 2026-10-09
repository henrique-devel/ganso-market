import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import {
  initialJevProtection,
  type JevProtection,
} from "../../storage/jev-protection.js";
import { jevHash } from "../../storage/jev-hash.js";
import type { JevManifest } from "../../storage/jev-manifest.js";
import type { LiveLease } from "../../storage/jev-live-store.js";
import { venueGridPrice } from "../../trading/price-grid.js";
import { liveCheck, LiveError, type LiveReservation } from "./live-contract.js";
import {
  requireLiveFreshSnapshot,
  type LiveSnapshot,
} from "./live-reconcile.js";
import {
  LiveExecution,
  LIVE_COMMAND_VERSION,
  type LiveCommand,
  type LiveReceipt,
} from "./live-execution.js";

export interface LiveProtectionRecord {
  version: "hyperliquid.live-protection.v1";
  position_id: string;
  observed_at: number;
  snapshot_id: string;
  state: "confirmed" | "pending" | "flat";
  protection: JevProtection | null;
  native_cloid: string | null;
  reasons: string[];
  urgent_close_requested: boolean;
}
/** Called on first partial and each reconciliation, independently of JEV.
 * A native position SL is a separate reduce-only order. ACK alone is never
 * protection confirmation; trigger alone is never a completed close. */
export class LiveProtectionCoordinator {
  constructor(
    readonly execution: LiveExecution,
    readonly refresh: () => Promise<LiveSnapshot>,
  ) {}
  async reconcile(input: {
    entry: LiveReservation;
    snapshot: LiveSnapshot;
    manifest: JevManifest;
    metadata: TradingInstrumentMetadata;
    metadata_at: number;
    lease: LiveLease;
    mark_price_raw: string | null;
    mark_at: number | null;
    risk_blocked: boolean;
  }): Promise<LiveProtectionRecord> {
    const { entry, metadata, lease } = input,
      { store, clock } = this.execution;
    liveCheck(
      entry.kind === "entry" &&
        jevHash(entry.identity) === jevHash(store.identity),
      "PROTECTION_OWNER",
    );
    const command = entry.request as Extract<LiveCommand, { kind: "entry" }>,
      plan = command.plan;
    liveCheck(
      command.kind === "entry" &&
        plan.manifest_hash === jevHash(input.manifest),
      "PROTECTION_MANIFEST",
    );
    const records = await store.events<LiveProtectionRecord>("protection");
    const previous =
      records
        .filter((r) => r.position_id === plan.input.order_id && r.protection)
        .at(-1)?.protection ?? null;
    let s = input.snapshot,
      protection = previous,
      native_cloid: string | null = null;
    const reasons: string[] = [],
      now = clock();
    let urgent_close_requested = false;
    const persist = async (state: LiveProtectionRecord["state"]) => {
      const r: LiveProtectionRecord = {
        version: "hyperliquid.live-protection.v1",
        position_id: plan.input.order_id,
        observed_at: clock(),
        snapshot_id: s.snapshot_id,
        state,
        protection,
        native_cloid,
        reasons: [...new Set(reasons)],
        urgent_close_requested,
      };
      await store.append("protection", `protection:${jevHash(r)}`, r);
      return r;
    };
    try {
      requireLiveFreshSnapshot(store.identity, s, now);
      await store.save(s);
      if ((await store.latest()).pending)
        reasons.push("FINANCIAL_RECONCILIATION_PENDING");
    } catch {
      reasons.push("RECONCILIATION_REQUIRED");
      urgent_close_requested = true;
      await store.append(
        "gap",
        `gap:protection:${jevHash({ snapshot_id: s.snapshot_id, reasons })}`,
        {
          reason: "RECONCILIATION_REQUIRED",
          snapshot_id: s.snapshot_id,
        },
      );
      return persist("pending");
    }
    const pos = BigInt(s.position_raw),
      quantity = (pos < 0n ? -pos : pos).toString();
    if (pos === 0n) {
      if (s.flat && s.history_complete && reasons.length === 0)
        return persist("flat");
      reasons.push("CANCEL_OR_HISTORY_PENDING");
      return persist("pending");
    }
    const receipts = await store.events<LiveReceipt>("receipt");
    const oids = receipts
      .filter((r) => r.operation_id === entry.operation_id && r.oid !== null)
      .map((r) => r.oid);
    const fills = s.fills
      .filter((f) => f.cloid === entry.cloid || oids.includes(f.oid))
      .sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
    const direction = pos > 0n ? "long" : "short";
    const owned =
      fills.length > 0 &&
      fills[0]!.start_position_raw === "0" &&
      direction === plan.input.direction &&
      fills.every(
        (f) =>
          f.maker &&
          f.side === (direction === "long" ? "buy" : "sell") &&
          f.price_raw === plan.input.entry_price_raw &&
          f.time >= Date.parse(plan.input.decision_at),
      ) &&
      fills.reduce((a, f) => a + BigInt(f.quantity_raw), 0n) <=
        BigInt(plan.quantity_btc_raw) &&
      BigInt(quantity) <=
        fills.reduce((a, f) => a + BigInt(f.quantity_raw), 0n);
    if (!owned) reasons.push("POSITION_OR_FILL_ATTRIBUTION_UNKNOWN");
    else if (!protection) {
      const first = fills[0]!;

      protection = initialJevProtection(
        input.manifest,
        {
          scope: entry.scope,
          position_id: plan.input.order_id,
          direction,
          first_fill_at: new Date(first.time).toISOString(),
          first_fill_price_raw: first.price_raw,
          quantity_btc_raw: quantity,
          atr14_raw: plan.input.atr14_raw,
          atr_captured_at: plan.input.atr_captured_at,
          decision_at: plan.input.decision_at,
        },
        metadata,
      );
      // Freeze the first-fill anchor before any network side effect or restart.
      await persist("pending");
    } else {
      if (
        protection.direction !== direction ||
        jevHash(protection.scope) !== jevHash(entry.scope)
      )
        reasons.push("POSITION_REVERSED");
      protection = { ...protection, quantity_btc_raw: quantity };
    }
    if (!s.history_complete) reasons.push("HISTORY_GAP");
    if (input.risk_blocked) reasons.push("RISK_BLOCKED");
    if (protection && now >= Date.parse(protection.maximum_exit_at))
      reasons.push("MAXIMUM_HOLDING_TIME");
    if (
      input.mark_at === null ||
      input.mark_price_raw === null ||
      input.mark_at > now ||
      now - input.mark_at > input.manifest.freshness.mark_funding_ms
    )
      reasons.push("MARK_UNKNOWN");
    else if (
      protection &&
      (direction === "long"
        ? BigInt(input.mark_price_raw) <= BigInt(protection.stop_price_raw)
        : BigInt(input.mark_price_raw) >= BigInt(protection.stop_price_raw))
    )
      reasons.push("STOP_TRIGGERED");
    const confirmed = async () => {
      if (!protection) return false;
      const requests = await store.operations();
      const stops = requests.filter(
        (r) =>
          r.kind === "stop" &&
          jevHash(r.scope) === jevHash(entry.scope) &&
          (r.request as Extract<LiveCommand, { kind: "stop" }>).protection
            .position_id === plan.input.order_id,
      );
      const stop = s.orders.find(
        (o) =>
          stops.some((r) => r.cloid === o.cloid) &&
          o.reduce_only &&
          o.position_stop &&
          o.side === (direction === "long" ? "sell" : "buy") &&
          o.trigger_price_raw === protection!.stop_price_raw &&
          BigInt(o.quantity_raw) >= BigInt(quantity),
      );
      if (stop) {
        native_cloid = stop.cloid;
        return true;
      }
      return false;
    };
    let nativeConfirmed = owned && (await confirmed());
    if (owned && protection && !nativeConfirmed) {
      const c: LiveCommand = {
        version: LIVE_COMMAND_VERSION,
        kind: "stop",
        scope: entry.scope,
        operation_id: `stop:${jevHash({ position_id: plan.input.order_id, quantity })}`,
        snapshot: s,
        metadata,
        metadata_at: input.metadata_at,
        protection,
      };
      const receipt = await this.execution.execute(c, lease);
      if (receipt.state === "acknowledged" || receipt.state === "open") {
        try {
          s = await this.refresh();
          requireLiveFreshSnapshot(store.identity, s, clock());
          await store.save(s);
          if ((await store.latest()).pending)
            reasons.push("FINANCIAL_RECONCILIATION_PENDING");
          liveCheck(
            s.position_raw === pos.toString(),
            "POSITION_CHANGED_DURING_STOP",
          );
          if (!s.history_complete) reasons.push("HISTORY_GAP");
          nativeConfirmed = await confirmed();
        } catch {
          reasons.push("STOP_CONFIRMATION_UNAVAILABLE");
        }
      }
    }
    if (!nativeConfirmed) reasons.push("PROTECTION_UNCONFIRMED");
    if (reasons.length) {
      urgent_close_requested = true;
      await store.append(
        "gap",
        `gap:protection:${jevHash({ snapshot_id: s.snapshot_id, reasons })}`,
        {
          reason: "PROTECTION_UNCONFIRMED",
          reasons,
          snapshot_id: s.snapshot_id,
        },
      );
      // Parent cancellation failure must not prevent an independent exit. Native
      // stops remain installed. Both concurrent exits are reduce-only at the venue.
      try {
        await this.execution.execute(
          {
            version: LIVE_COMMAND_VERSION,
            kind: "cancel",
            scope: entry.scope,
            operation_id: `cancel:${jevHash(entry.operation_id)}`,
            metadata,
            metadata_at: input.metadata_at,
            target_operation_id: entry.operation_id,
            target_cloid: entry.cloid,
          },
          lease,
        );
      } catch {
        reasons.push("ENTRY_CANCEL_PENDING");
      }
      try {
        const limit = venueGridPrice(
          input.mark_price_raw !== null &&
            input.mark_at !== null &&
            input.mark_at <= clock() &&
            clock() - input.mark_at <= input.manifest.freshness.mark_funding_ms
            ? (BigInt(input.mark_price_raw) *
                (direction === "long" ? 9n : 11n)) /
                10n
            : BigInt(plan.worst_exit_price_raw),
          1n,
          direction === "long" ? "down" : "up",
          metadata,
        );
        liveCheck(limit !== null && limit > 0n, "CLOSE_PRICE");
        await this.execution.execute(
          {
            version: LIVE_COMMAND_VERSION,
            kind: "close",
            scope: entry.scope,
            operation_id: `close:${jevHash({ entry: entry.operation_id, snapshot: s.snapshot_id })}`,
            snapshot: s,
            metadata,
            metadata_at: input.metadata_at,
            limit_price_raw: limit.toString(),
            cause: reasons.join(",").slice(0, 160),
          },
          lease,
        );
      } catch (e) {
        reasons.push(e instanceof LiveError ? e.code : "URGENT_CLOSE_PENDING");
      }
      return persist("pending");
    }
    return persist("confirmed");
  }
}
