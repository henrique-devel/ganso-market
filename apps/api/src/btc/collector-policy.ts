import {
  BTC_STORAGE_LIMIT_BYTES,
  BTC_STORAGE_STOP_BYTES,
} from "../trading/retention.js";

export type CollectorLimits = Readonly<{
  intervalMs: number;
  diskReserveBytes: number;
  rawBytes: number;
  totalBytes: number;
  physicalBytes: number;
  connectionReserve: number;
}>;

// Legacy admission remains unchanged. A pilot never changes SQL quotas.
export const COLLECTOR_LIMITS: CollectorLimits = Object.freeze({
  intervalMs: 1000,
  diskReserveBytes: 1024 ** 3,
  rawBytes: 4 * 1024 ** 3,
  totalBytes: 6 * 1024 ** 3,
  physicalBytes: 4 * 1024 ** 3,
  connectionReserve: 8,
});
export const PILOT_PROFILE = "btc-pilot-4-16-12.v1";
export const PILOT_MAX_MS = 6 * 3600_000;
export const PILOT_LIMITS: CollectorLimits = Object.freeze({
  ...COLLECTOR_LIMITS,
  totalBytes: 16 * 1024 ** 3,
  physicalBytes: 12 * 1024 ** 3,
});
export type CollectorPilot = {
  profile: typeof PILOT_PROFILE;
  starts_at: string;
  stops_at: string;
};
export const STORAGE_PROFILE = "btc-storage-200gb-80pct.v1";
export const STORAGE_BUDGET = Object.freeze({
  profile: STORAGE_PROFILE,
  limitBytes: BTC_STORAGE_LIMIT_BYTES.toString(),
  stopBytes: BTC_STORAGE_STOP_BYTES.toString(),
  stopPercent: 80,
});
export const STORAGE_LIMITS: CollectorLimits = Object.freeze({
  ...COLLECTOR_LIMITS,
  rawBytes: Number(BTC_STORAGE_STOP_BYTES),
  totalBytes: Number(BTC_STORAGE_STOP_BYTES),
  physicalBytes: Number(BTC_STORAGE_STOP_BYTES),
});
export type BtcWorkerConfig = {
  enabled: boolean;
  pilot?: CollectorPilot;
  storageProfile?: typeof STORAGE_PROFILE;
};

export function inspectBtcWorkerConfig(value: unknown): BtcWorkerConfig {
  const fail = (): never => {
    throw new Error("BTC_WORKER_INVALID_CONFIG");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (v.execution_mode !== "paper" || typeof v.enabled !== "boolean") fail();
  const fields = ["schema_version", "execution_mode", "enabled"];
  if (v.schema_version === 1) {
    if (Object.keys(v).some((key) => !fields.includes(key))) fail();
    return { enabled: v.enabled as boolean };
  }
  if (v.schema_version === 3) {
    fields.push("capacity_profile");
    if (
      v.capacity_profile !== STORAGE_PROFILE ||
      Object.keys(v).some((key) => !fields.includes(key))
    )
      fail();
    return { enabled: v.enabled as boolean, storageProfile: STORAGE_PROFILE };
  }
  if (v.schema_version !== 2 || v.capacity_profile !== PILOT_PROFILE) fail();
  fields.push("capacity_profile", "starts_at", "stops_at");
  if (Object.keys(v).some((key) => !fields.includes(key))) fail();
  for (const key of ["starts_at", "stops_at"] as const) {
    const stamp = v[key];
    if (
      typeof stamp !== "string" ||
      !Number.isFinite(Date.parse(stamp)) ||
      new Date(stamp).toISOString() !== stamp
    )
      fail();
  }
  const starts_at = v.starts_at as string,
    stops_at = v.stops_at as string;
  const duration = Date.parse(stops_at) - Date.parse(starts_at);
  if (duration <= 0 || duration > PILOT_MAX_MS) fail();
  return {
    enabled: v.enabled as boolean,
    pilot: { profile: PILOT_PROFILE, starts_at, stops_at },
  };
}

export function assertPilotActive(
  pilot: CollectorPilot | undefined,
  now: number,
): void {
  if (!pilot) return;
  if (!Number.isFinite(now) || now < Date.parse(pilot.starts_at))
    throw new Error("BTC_COLLECTOR_PILOT_NOT_STARTED");
  if (now >= Date.parse(pilot.stops_at))
    throw new Error("BTC_COLLECTOR_PILOT_EXPIRED");
}
