import { expect, it } from "vitest";
import {
  createReadRecovery,
  RECOVERY_LIMITS,
  snapshotNetworkError,
  SnapshotTransportError,
} from "../../src/venues/hyperliquid/recovery.js";

it("jitter stays within backoff/cadence bounds and success cannot replenish a burst", () => {
  let now = 0;
  const low = createReadRecovery(
    () => now,
    () => 0,
  );
  const high = createReadRecovery(
    () => now,
    () => 1,
  );
  expect([low.fail(1000), high.fail(1000)]).toEqual([1000, 1000]);
  expect([low.fail(1000), high.fail(1000)]).toEqual([1000, 2000]);
  expect([low.fail(1000), high.fail(1000)]).toEqual([2000, 4000]);
  for (let i = 0; i < 3; i++) high.fail(1000);
  high.success();
  expect(high.fail(1000)).toBeNull();
  now = RECOVERY_LIMITS.windowMs;
  expect(high.fail(1000)).toBeNull(); // Terminal latch; no timer rearms it.
  expect(low.fail(1000)).toBe(4000);
  expect(low.status().retries_in_window).toBe(1);
});

it("only named network failures from fetch are retryable; TLS/unknown/SQL are terminal", () => {
  for (const code of ["ECONNRESET", "EAI_AGAIN", "UND_ERR_SOCKET"])
    expect(
      snapshotNetworkError(new TypeError("private", { cause: { code } })),
    ).toBeInstanceOf(SnapshotTransportError);
  for (const error of [
    new TypeError("unknown"),
    new TypeError("tls", { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }),
    Object.assign(new Error("commit uncertain"), { code: "ECONNRESET" }),
  ])
    expect(snapshotNetworkError(error)).toBe(error);
});
