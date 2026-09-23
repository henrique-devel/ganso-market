import { describe, expect, it } from "vitest";
import { inspectBtcWorkerConfig } from "../src/btc-worker.js";

describe("inactive BTC worker boundary", () => {
  it("accepts only an explicitly disabled paper configuration", () => {
    expect(() =>
      inspectBtcWorkerConfig({
        schema_version: 1,
        execution_mode: "paper",
        enabled: false,
      }),
    ).not.toThrow();
  });
  it.each([
    null,
    {},
    { schema_version: 1, execution_mode: "paper", enabled: true },
    { schema_version: 1, execution_mode: "live", enabled: false },
    { schema_version: 2, execution_mode: "paper", enabled: false },
  ])(
    "fails closed instead of starting incomplete business logic: %j",
    (config) => {
      expect(() => inspectBtcWorkerConfig(config)).toThrow(
        "BTC_WORKER_NOT_IMPLEMENTED_OR_INVALID_CONFIG",
      );
    },
  );
});
