import { vi } from "vitest";
import { LiveExecution } from "../../src/venues/hyperliquid/live-execution.js";
import type {
  LiveStore,
  LiveEventKind,
  LiveLease,
} from "../../src/storage/jev-live-store.js";
import {
  liveCheck,
  liveCloid,
  type LiveReservation,
} from "../../src/venues/hyperliquid/live-contract.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { liveIdentity, liveSnapshot } from "./live-fixture.js";
export class MemoryLiveStore implements LiveStore {
  identity = liveIdentity;
  requests: LiveReservation[] = [];
  journal: Array<{ kind: LiveEventKind; key: string; payload: unknown }> = [];
  snapshot: ReturnType<typeof liveSnapshot> | null = null;
  constructor(readonly clock: () => number) {}
  async append(kind: LiveEventKind, key: string, payload: unknown) {
    const old = this.journal.find((e) => e.key === key);
    if (old)
      liveCheck(jevHash(old.payload) === jevHash(payload), "SOURCE_COLLISION");
    else this.journal.push({ kind, key, payload: structuredClone(payload) });
  }
  async save(s: ReturnType<typeof liveSnapshot>) {
    this.snapshot = structuredClone(s);
  }
  async latest() {
    return { snapshot: this.snapshot, pending: !this.snapshot };
  }
  async reserve(i: Parameters<LiveStore["reserve"]>[0]) {
    const hash = jevHash({
      scope: i.scope,
      kind: i.kind,
      operation_id: i.operation_id,
      request: i.request,
    });
    const previous = this.requests.find(
      (r) => r.operation_id === i.operation_id,
    );
    if (previous) {
      liveCheck(previous.request_hash === hash, "IDEMPOTENCY_COLLISION");
      return { fresh: false, reservation: previous };
    }
    const cloid = liveCloid(this.identity, i.scope, i.operation_id),
      nonce = this.clock() + this.requests.length;
    const r: LiveReservation = {
      identity: this.identity,
      scope: i.scope,
      operation_id: i.operation_id,
      kind: i.kind,
      generation: i.lease.generation,
      nonce,
      expires_after: nonce + 1500,
      cloid,
      request: i.request,
      request_hash: hash,
      action: i.action(cloid),
    };
    this.requests.push(structuredClone(r));
    return { fresh: true, reservation: r };
  }
  async gate(r: LiveReservation) {
    return {
      identity_hash: jevHash(this.identity),
      reservation_hash: jevHash(r),
      operator_activation_id: "fixture-only",
      signer_enabled: true,
      entries_allowed: true,
      generation: r.generation,
      lease_until: this.clock() + 6000,
    };
  }
  async operations() {
    return structuredClone(this.requests);
  }
  async events<T>(kind: LiveEventKind) {
    return this.journal
      .filter((e) => e.kind === kind)
      .map((e) => structuredClone(e.payload) as T);
  }
}
export const fixtureLease: LiveLease = {
  process_id: "fixture-only",
  generation: "1",
  lease_until: Infinity,
};
export function executionFixture() {
  let now = Date.parse("2026-10-09T06:00:00.000Z");
  const clock = () => now,
    store = new MemoryLiveStore(clock);
  const submit = vi.fn().mockResolvedValue({
    status: "ok",
    response: {
      type: "order",
      data: { statuses: [{ resting: { oid: 1 } }] },
    },
  });
  const info = vi.fn().mockResolvedValue({ status: "unknownOid" });
  const execution = new LiveExecution(store, { submit, info }, clock);
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    store,
    submit,
    info,
    execution,
  };
}
