import { describe, expect, it } from "vitest";
import {
  assertPilotActive,
  inspectBtcWorkerConfig,
  PILOT_LIMITS,
  PILOT_PROFILE,
} from "../src/btc/collector-policy.js";
import {
  assertCollectorCapacity,
  collectorHorizon,
  effectiveCollectorLimits,
  type CapacitySample,
} from "../src/btc/collector.js";

const start = Date.parse("2026-09-29T01:00:00.000Z");
const config = {
  schema_version: 2,
  execution_mode: "paper",
  enabled: true,
  capacity_profile: PILOT_PROFILE,
  starts_at: new Date(start).toISOString(),
  stops_at: new Date(start + 6 * 3600_000).toISOString(),
};
const GiB = 1024 ** 3;
const sample: CapacitySample = {
  diskTotalBytes: "322302373888",
  diskAvailableBytes: "291040284672",
  rawBytes: "2147899519",
  totalBytes: "8417131678",
  physicalBytes: "5186740224",
  rawQuotaBytes: String(10 * GiB),
  totalQuotaBytes: String(12 * GiB),
  physicalQuotaBytes: String(14 * GiB),
  databaseBytes: "7385454271",
  walLsn: "1/0",
  connections: 3,
  maxConnections: 40,
  retentionBlocked: false,
  hold: true,
};

describe("explicit bounded BTC collector pilot", () => {
  it("keeps legacy configuration/default limits and requires a named pilot", () => {
    expect(
      inspectBtcWorkerConfig({
        schema_version: 1,
        execution_mode: "paper",
        enabled: true,
      }),
    ).toEqual({ enabled: true });
    expect(() => assertCollectorCapacity(sample)).toThrow("STORAGE_LIMIT");
    expect(() => assertCollectorCapacity(sample, PILOT_LIMITS)).not.toThrow();
    expect(PILOT_LIMITS).toMatchObject({
      rawBytes: 4 * GiB,
      totalBytes: 16 * GiB,
      physicalBytes: 12 * GiB,
    });
    expect(effectiveCollectorLimits(sample, PILOT_LIMITS)).toMatchObject({
      rawBytes: 4 * GiB,
      totalBytes: 12 * GiB,
      physicalBytes: 12 * GiB,
    });
  });
  it.each([
    { capacity_profile: "unbounded" },
    { execution_mode: "live" },
    { stops_at: undefined },
    { starts_at: "invalid" },
    { stops_at: config.starts_at },
    { stops_at: new Date(start - 1).toISOString() },
    { stops_at: new Date(start + 6 * 3600_000 + 1).toISOString() },
    { stops_at: "2026-09-29T07:00:00+00:00" },
    { totalBytes: 99 * GiB },
    { schema_version: 1 },
  ])("refuses invalid/extended/implicit pilot configuration %j", (delta) => {
    expect(() => inspectBtcWorkerConfig({ ...config, ...delta })).toThrow(
      "BTC_WORKER_INVALID_CONFIG",
    );
  });
  it("keeps the absolute window across restarts and refuses its boundaries", () => {
    const pilot = inspectBtcWorkerConfig(config).pilot!;
    expect(() => assertPilotActive(pilot, start - 1)).toThrow("NOT_STARTED");
    expect(() => assertPilotActive(pilot, start)).not.toThrow();
    expect(() =>
      assertPilotActive(pilot, start + 6 * 3600_000 - 1),
    ).not.toThrow();
    expect(() => assertPilotActive(pilot, start + 6 * 3600_000)).toThrow(
      "EXPIRED",
    );
    expect(() =>
      assertPilotActive(
        inspectBtcWorkerConfig(config).pilot,
        start + 7 * 3600_000,
      ),
    ).toThrow("EXPIRED");
  });
  it.each([
    { rawBytes: String(4 * GiB) },
    { totalBytes: String(12 * GiB) },
    { physicalBytes: String(12 * GiB) },
    { retentionBlocked: true },
    { totalQuotaBytes: String(7 * GiB) },
    { physicalQuotaBytes: String(4 * GiB) },
    { diskAvailableBytes: String(322302373888 / 4 + GiB) },
    { maxConnections: 14 },
  ])(
    "keeps independent worker, SQL, disk and connection guards %j",
    (delta) => {
      expect(() =>
        assertCollectorCapacity({ ...sample, ...delta }, PILOT_LIMITS),
      ).toThrow();
    },
  );
  it.each(["0", "-1", "NaN", "", "9007199254740992"])(
    "rejects unknown SQL quota %s",
    (value) => {
      expect(() =>
        assertCollectorCapacity(
          { ...sample, totalQuotaBytes: value },
          PILOT_LIMITS,
        ),
      ).toThrow("CAPACITY_UNKNOWN");
    },
  );
  it("calculates the horizon against SQL's smaller quota, never the 16 GiB advertised ceiling", () => {
    const before = { ...sample, totalBytes: String(9 * GiB) };
    const after = { ...sample, totalBytes: String(10 * GiB) };
    expect(
      collectorHorizon(before, after, 3600_000, PILOT_LIMITS),
    ).toMatchObject({
      logical: { remaining_seconds: 7200, bytes_per_hour: GiB },
    });
  });
});
