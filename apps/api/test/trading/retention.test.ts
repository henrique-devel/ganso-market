import { describe, expect, it } from "vitest";
import {
  validateRetentionObject,
  assertEvidenceJson,
  type RetentionObject,
} from "../../src/trading/retention.js";
const value: RetentionObject = {
  id: "a",
  class: "raw",
  identity: { mode: "paper", instrument_id: "BTC", instrument_version: "v1" },
  recordedAt: new Date(),
  payload: {},
  dependencies: [],
};
describe("BTC storage envelope", () => {
  it("accepts ownerless public feed data", () => {
    expect(() => validateRetentionObject(value)).not.toThrow();
  });
  it.each([
    { class: "financial" },
    { class: "decision" },
    { class: "experiment" },
    { class: "unknown" },
    { identity: { ...value.identity, mode: "live" } },
    { dependencies: ["a"] },
    { dependencies: ["b", "b"] },
    { recordedAt: new Date(NaN) },
  ])("refuses invalid or unsafe envelope %j", (change) => {
    expect(() =>
      validateRetentionObject({ ...value, ...change } as RetentionObject),
    ).toThrow("INVALID_ENVELOPE");
  });
});

describe("evidence JSON", () => {
  it.each([
    NaN,
    Infinity,
    undefined,
    1n,
    { missing: undefined },
    new Date(),
    [undefined],
  ])("rejects lossy value %s", (value) => {
    expect(() => assertEvidenceJson(value)).toThrow("INVALID_JSON");
  });
  it("rejects circular evidence", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => assertEvidenceJson(value)).toThrow("INVALID_JSON");
  });
});
