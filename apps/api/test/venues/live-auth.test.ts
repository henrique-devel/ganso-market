import { describe, expect, it, vi } from "vitest";
import {
  createHyperliquidLiveBoundary,
  type LiveWire,
} from "../../src/venues/hyperliquid/live-auth.js";
import {
  LIVE_VERSION,
  liveCloid,
  liveRaw,
  liveDecimal,
  validateLiveIdentity,
  type LiveIdentity,
  type LiveGate,
  type LiveReservation,
} from "../../src/venues/hyperliquid/live-contract.js";
import { liveEntryCommand } from "./live-fixture.js";
import { buildLiveAction } from "../../src/venues/hyperliquid/live-execution.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { jevIdentity } from "../trading/jev-v2-fixture.js";
import { jevScope } from "../../src/storage/jev-ledger.js";

const identity: LiveIdentity = {
  version: LIVE_VERSION,
  mode: "live",
  environment: "mainnet",
  owner_id: "operator",
  account_id: "live",
  account_address: `0x${"1".repeat(40)}`,
  signer_address: `0x${"2".repeat(40)}`,
  signer_generation: "agent-v1",
  vault_address: null,
};
const now = Date.parse("2026-10-09T06:00:00.000Z");
function setup() {
  const i = jevIdentity("live");
  const scope = {
    ...jevScope(i.bindings[0]!.binding, i.instrument),
    account_id: "live",
  };
  const r: LiveReservation = {
    identity,
    scope,
    operation_id: "entry:1",
    kind: "entry",
    generation: "4",
    nonce: now,
    expires_after: now + 1500,
    cloid: liveCloid(identity, scope, "entry:1"),
    request_hash: "a".repeat(64),
    request: {},
    action: {
      type: "order",
      orders: [
        {
          a: 0,
          b: true,
          p: "64000",
          s: "0.001",
          r: false,
          t: { limit: { tif: "Alo" } },
          c: liveCloid(identity, scope, "entry:1"),
        },
      ],
      grouping: "na",
    },
  };
  const command = liveEntryCommand(now);
  command.scope = scope;
  command.plan.input.scope = scope;
  command.snapshot.identity_hash = jevHash(identity);
  r.request = command;
  r.action = buildLiveAction(identity, command, r.cloid, now);
  const gate: LiveGate = {
    identity_hash: validateLiveIdentity(identity),
    reservation_hash: jevHash(r),
    operator_activation_id: "operator:fixture",
    signer_enabled: true,
    entries_allowed: true,
    generation: "4",
    lease_until: now + 2000,
  };
  const request = vi.fn().mockResolvedValue({ status: "ok" });
  const wire: LiveWire = { isTestnet: false, request };
  const signTypedData = vi.fn().mockResolvedValue(`0x${"3".repeat(128)}1b`);
  const wallet = {
    address: identity.signer_address,
    signTypedData: async (params: unknown) => signTypedData(params),
  };
  return { r, gate, wire, request, wallet, signTypedData };
}
describe("JE13 authenticated boundary (no venue request)", () => {
  it("never signs the same claimed intent twice and binds testnet signing to source b", async () => {
    const f = setup(),
      i = { ...identity, environment: "testnet" as const },
      r = structuredClone(f.r),
      command = r.request as ReturnType<typeof liveEntryCommand>;
    r.identity = i;
    r.scope.instrument_id = "hyperliquid:testnet:BTC";
    command.scope = r.scope;
    command.plan.input.scope = r.scope;
    command.metadata = {
      ...command.metadata,
      instrument: {
        ...command.metadata.instrument,
        instrument_id: "hyperliquid:testnet:BTC",
        origin: {
          ...command.metadata.instrument.origin,
          instrument_id: "hyperliquid:testnet:BTC",
          source_id: "hyperliquid:testnet:meta-observation",
        },
      },
    };
    command.snapshot.identity_hash = jevHash(i);
    r.cloid = liveCloid(i, r.scope, r.operation_id);
    r.action = buildLiveAction(i, command, r.cloid, now);
    let attempts = 0;
    const a = createHyperliquidLiveBoundary({
      identity: i,
      executor_enabled: true,
      wallet: f.wallet,
      wire: { ...f.wire, isTestnet: true },
      clock: () => now,
      claim: async () => attempts++ === 0,
      gate: async () => ({
        ...f.gate,
        identity_hash: jevHash(i),
        reservation_hash: jevHash(r),
      }),
    });
    await a.submit(r);
    await expect(a.submit(r)).rejects.toThrow("SEND_ALREADY_CLAIMED");
    expect(f.signTypedData).toHaveBeenCalledTimes(1);
    expect(f.signTypedData.mock.calls[0]![0].message.source).toBe("b");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("a supplied wallet cannot enable the default executor", async () => {
    const f = setup();
    const a = createHyperliquidLiveBoundary({
      identity,
      claim: async () => true,
      ...f,
      gate: async () => f.gate,
      clock: () => now,
    });
    expect(a.executor_enabled).toBe(false);
    await expect(a.submit(f.r)).rejects.toThrow("EXECUTOR_DISABLED");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.signTypedData).not.toHaveBeenCalled();
    const config: Parameters<typeof createHyperliquidLiveBoundary>[0] = {
      identity,
      wallet: f.wallet,
      wire: f.wire,
      gate: async () => f.gate,
      claim: async () => true,
      clock: () => now,
      executor_enabled: false,
    };
    const disabled = createHyperliquidLiveBoundary(config);
    config.executor_enabled = true;
    await expect(disabled.submit(f.r)).rejects.toThrow("EXECUTOR_DISABLED");
  });
  it("rejects absent operator activation, stale fences, identity mutation and unknown environments", async () => {
    for (const delta of [
      { signer_enabled: false },
      { operator_activation_id: null },
      { generation: "3" },
      { lease_until: now },
      { reservation_hash: "wrong" },
    ]) {
      const f = setup();
      const a = createHyperliquidLiveBoundary({
        identity,
        claim: async () => true,
        wallet: f.wallet,
        wire: f.wire,
        executor_enabled: true,
        gate: async () => ({ ...f.gate, ...delta }),
        clock: () => now,
      });
      await expect(a.submit(f.r)).rejects.toThrow();
      expect(f.signTypedData).not.toHaveBeenCalled();
    }
    expect(() =>
      validateLiveIdentity({
        ...identity,
        environment: "development",
      } as unknown as LiveIdentity),
    ).toThrow("MODE_ENVIRONMENT");
    expect(() =>
      createHyperliquidLiveBoundary({
        identity,
        claim: async () => true,
        wire: { ...setup().wire, isTestnet: true },
        gate: async () => setup().gate,
      }),
    ).toThrow("TRANSPORT_ENVIRONMENT");
  });
  it("signs the canonical SDK action and correct phantom-agent environment, with persisted nonce/expiry", async () => {
    const f = setup();
    const a = createHyperliquidLiveBoundary({
      identity,
      claim: async () => true,
      wallet: f.wallet,
      wire: f.wire,
      executor_enabled: true,
      gate: async () => f.gate,
      clock: () => now,
    });
    await a.submit(f.r);
    const typed = f.signTypedData.mock.calls[0]![0];
    expect(typed.domain.chainId).toBe(1337);
    expect(typed.message.source).toBe("a");
    expect(f.request.mock.calls[0]![0]).toBe("exchange");
    expect(f.request.mock.calls[0]![1]).toMatchObject({
      nonce: now,
      expiresAfter: now + 1500,
      action: { orders: [{ t: { limit: { tif: "Alo" } } }] },
    });
  });
  it("binds reads to the actual account, rejects query-owner injection, and scrubs errors", async () => {
    const f = setup();
    const a = createHyperliquidLiveBoundary({
      identity,
      claim: async () => true,
      wire: f.wire,
      gate: async () => f.gate,
    });
    await a.info("clearinghouseState");
    expect(f.request.mock.calls[0]![1]).toEqual({
      type: "clearinghouseState",
      user: identity.account_address,
    });
    await expect(
      a.info("clearinghouseState", { user: identity.signer_address }),
    ).rejects.toThrow("QUERY_OWNER");
    f.request.mockRejectedValue(new Error("sensitive upstream payload"));
    await expect(a.info("clearinghouseState")).rejects.toThrow(
      "READ_UNAVAILABLE",
    );
  });
  it("uses exact decimals and separates client IDs by environment/profile/generation", () => {
    expect(liveRaw("-0.00000100", 6)).toBe("-1");
    expect(liveDecimal("64000000000", 6)).toBe("64000");
    expect(() => liveRaw("0.0000001", 6)).toThrow("PRECISION");
    const f = setup();
    expect(liveCloid(identity, f.r.scope, "entry:1")).toBe(f.r.cloid);
    expect(
      liveCloid(
        { ...identity, signer_generation: "agent-v2" },
        f.r.scope,
        "entry:1",
      ),
    ).not.toBe(f.r.cloid);
    expect(
      liveCloid(identity, { ...f.r.scope, profile_version: "new" }, "entry:1"),
    ).not.toBe(f.r.cloid);
  });
});
