import type { JevScope } from "@ganso-market/contracts/trading";
import { jevHash } from "../../storage/jev-hash.js";
import { assertEvidenceJson } from "../../trading/retention.js";

export const LIVE_VERSION = "hyperliquid.live.v1" as const;
export const LIVE_URLS = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const;
export type LiveEnvironment = keyof typeof LIVE_URLS;
export interface LiveIdentity {
  version: typeof LIVE_VERSION;
  mode: "live";
  environment: LiveEnvironment;
  owner_id: string;
  account_id: string;
  account_address: `0x${string}`;
  signer_address: `0x${string}`;
  signer_generation: string;
  vault_address: `0x${string}` | null;
}
/** Public identity only. Wallets, signatures and private material never enter a journal. */
export interface LiveGate {
  identity_hash: string;
  reservation_hash: string | null;
  operator_activation_id: string | null;
  signer_enabled: boolean;
  entries_allowed: boolean;
  generation: string;
  lease_until: number;
}
export interface LiveReservation {
  identity: LiveIdentity;
  scope: JevScope;
  operation_id: string;
  kind: "entry" | "close" | "stop" | "cancel";
  generation: string;
  nonce: number;
  expires_after: number;
  cloid: `0x${string}`;
  action: Record<string, unknown>;
  request: unknown;
  request_hash: string;
}
export class LiveError extends Error {
  constructor(readonly code: string) {
    super(`HYPERLIQUID_LIVE_${code}`);
    this.name = "LiveError";
  }
}
export function liveCheck(ok: unknown, code: string): asserts ok {
  if (!ok) throw new LiveError(code);
}
export function liveRecord(value: unknown): Record<string, unknown> {
  liveCheck(
    value && typeof value === "object" && !Array.isArray(value),
    "RESPONSE",
  );
  return value as Record<string, unknown>;
}
export function liveInteger(value: unknown, min = 0): number {
  liveCheck(Number.isSafeInteger(value) && (value as number) >= min, "INTEGER");
  return value as number;
}
export function liveRaw(value: unknown, decimals: number): string {
  liveCheck(
    typeof value === "string" &&
      value.length <= 80 &&
      /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value),
    "DECIMAL",
  );
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  liveCheck(
    fraction
      .slice(decimals)
      .split("")
      .every((n) => n === "0"),
    "PRECISION",
  );
  const raw =
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0");
  return (negative ? -raw : raw).toString();
}
export function liveDecimal(raw: string, decimals: number): string {
  liveCheck(/^(0|[1-9][0-9]*)$/.test(raw), "UNSIGNED_AMOUNT");
  const padded = raw.padStart(decimals + 1, "0");
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(
    /\.?0+$/,
    "",
  );
}
export function validateLiveIdentity(i: LiveIdentity) {
  assertEvidenceJson(i);
  liveCheck(
    Object.keys(i).sort().join() ===
      "account_address,account_id,environment,mode,owner_id,signer_address,signer_generation,vault_address,version",
    "IDENTITY_FIELDS",
  );
  liveCheck(
    i.version === LIVE_VERSION &&
      i.mode === "live" &&
      Object.hasOwn(LIVE_URLS, i.environment),
    "MODE_ENVIRONMENT",
  );
  for (const id of [i.account_id, i.owner_id, i.signer_generation])
    liveCheck(
      typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id),
      "IDENTITY_ID",
    );
  for (const a of [
    i.account_address,
    i.signer_address,
    ...(i.vault_address ? [i.vault_address] : []),
  ])
    liveCheck(/^0x[a-f0-9]{40}$/.test(a) && !/^0x0{40}$/.test(a), "ADDRESS");
  liveCheck(
    i.vault_address === null || i.vault_address === i.account_address,
    "VAULT_ACCOUNT",
  );
  return jevHash(i);
}
export function liveCloid(
  i: LiveIdentity,
  scope: JevScope,
  operation: string,
): `0x${string}` {
  validateLiveIdentity(i);
  liveCheck(
    scope.mode === "live" &&
      scope.owner_id === i.owner_id &&
      scope.account_id === i.account_id &&
      scope.instrument_id === `hyperliquid:${i.environment}:BTC`,
    "SCOPE",
  );
  liveCheck(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(operation),
    "OPERATION_ID",
  );
  return `0x${jevHash({ identity: i, scope, operation }).slice(0, 32)}`;
}
export function assertLiveGate(
  i: LiveIdentity,
  r: LiveReservation,
  g: LiveGate,
  now: number,
) {
  liveCheck(
    validateLiveIdentity(i) === validateLiveIdentity(r.identity) &&
      g.identity_hash === validateLiveIdentity(i) &&
      r.cloid === liveCloid(i, r.scope, r.operation_id),
    "OWNER",
  );
  liveCheck(g.signer_enabled && !!g.operator_activation_id, "SIGNER_DISABLED");
  liveCheck(g.reservation_hash === jevHash(r), "RESERVATION_CHANGED");
  liveCheck(
    g.generation === r.generation &&
      g.lease_until > now &&
      r.expires_after > now &&
      r.expires_after <= r.nonce + 2000 &&
      r.nonce <= now + 1000 &&
      r.nonce >= now - 2000,
    "FENCE_OR_CLOCK",
  );
  liveCheck(r.kind !== "entry" || g.entries_allowed, "ENTRIES_PAUSED");
}
