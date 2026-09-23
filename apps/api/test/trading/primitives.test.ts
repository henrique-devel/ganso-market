import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as fixed from "../../src/trading/fixed.js";
import * as legacyFixed from "../../src/polymarket/fundamental/fixed.js";
import { compositeKey } from "../../src/trading/identity.js";
import {
  canonicalFingerprint,
  compareReplayOrder,
  utcBucketStart,
} from "../../src/trading/replay.js";
import { financialOwnerKey } from "../../src/polymarket/paper/financial.js";

describe("shared financial primitives", () => {
  it("keeps one exact arithmetic implementation behind the legacy imports", () => {
    for (const name of Object.keys(fixed) as (keyof typeof fixed)[]) {
      expect(legacyFixed[name]).toBe(fixed[name]);
    }
    expect(fixed).not.toHaveProperty("formatProbabilityScaled");
    expect(fixed).not.toHaveProperty("probabilityToScaled");
    expect(fixed).not.toHaveProperty("scaledToNumber");
    expect(fixed.parseScaled("9007199254740993.000000001")).toBe(
      9007199254740993000000001n,
    );
    expect(fixed.formatScaled(-9007199254740993000000001n, 9)).toBe(
      "-9007199254740993.000000001",
    );
    expect(fixed.parseScaled("-0.0000000001")).toBeNull();
    expect(fixed.parseScaled("-0.0000000010")).toBe(-1n);
    expect(fixed.divRound(5n, -2n)).toBe(-3n);
    expect(fixed.divRound(-5n, -2n)).toBe(3n);
    expect(fixed.mul(-1n, 500_000_000n)).toBe(-1n);
    // Compatibility semantics, not an implicit contract-scale conversion.
    expect(fixed.divRound(1n, 0n)).toBe(0n);
    expect(fixed.div(1n, 0n)).toBe(0n);
  });

  it("encodes identity dimensions without separator collisions or changing legacy keys", () => {
    expect(compositeKey(["a:b", "c"])).not.toBe(compositeKey(["a", "b:c"]));
    expect(compositeKey(['a"', "\\b"])).toBe('["a\\\"","\\\\b"]');
    const scope = ["account", "experiment", "instrument"];
    for (let dimension = 0; dimension < scope.length; dimension++) {
      const other = [...scope];
      other[dimension] += "-other";
      expect(compositeKey(other)).not.toBe(compositeKey(scope));
    }
    expect(financialOwnerKey("fixture", "A")).toBe('["fixture","A"]');
    expect(financialOwnerKey("fixture", "A")).toBe(
      compositeKey(["fixture", "A"]),
    );
  });

  it("preserves fingerprint bytes, nested key sorting, arrays and conflict detection", () => {
    const first = { z: [null, { b: "0.40", a: true }], a: "1" };
    const reordered = { a: "1", z: [null, { a: true, b: "0.40" }] };
    expect(canonicalFingerprint(first)).toBe(
      '{"a":"1","z":[null,{"a":true,"b":"0.40"}]}',
    );
    expect(canonicalFingerprint(reordered)).toBe(canonicalFingerprint(first));
    expect(canonicalFingerprint({ ...first, a: "2" })).not.toBe(
      canonicalFingerprint(first),
    );
    expect(canonicalFingerprint(["a", "b"])).not.toBe(
      canonicalFingerprint(["b", "a"]),
    );
    expect(() => canonicalFingerprint({ missing: undefined })).toThrow(
      "Invalid fingerprint payload",
    );
    expect(() =>
      canonicalFingerprint({ nested: [undefined] }, () => {
        throw new Error("FIN03_INVALID_PAYLOAD");
      }),
    ).toThrow("FIN03_INVALID_PAYLOAD");
  });

  it("orders by economic time then bytewise key, regardless of arrival or event ID", () => {
    const early = new Date("2026-09-12T10:00:00Z");
    const late = new Date("2026-09-12T11:00:00Z");
    const events = [
      { eventTs: late, idempotencyKey: "a", eventId: "1" },
      { eventTs: early, idempotencyKey: "a", eventId: "2" },
      { eventTs: early, idempotencyKey: "Z", eventId: "999" },
    ];
    expect(
      events.toSorted(compareReplayOrder).map((event) => event.eventId),
    ).toEqual(["999", "2", "1"]);
    const retry = { ...events[0]!, eventId: "88" };
    expect(compareReplayOrder(events[0]!, retry)).toBe(0);
  });

  it("keeps Monday UTC weeks and never mutates event timestamps", () => {
    const at = new Date("2026-09-13T23:30:00-03:00");
    const before = at.getTime();
    expect(utcBucketStart(at, false)).toBe("2026-09-14");
    expect(utcBucketStart(at, true)).toBe("2026-09-14");
    expect(utcBucketStart(new Date("2026-09-13T23:59:59Z"), true)).toBe(
      "2026-09-07",
    );
    expect(at.getTime()).toBe(before);
  });
});

describe("neutral dependency boundary", () => {
  it("keeps core modules self-contained, without legacy, runtime or external imports", () => {
    const directory = new URL("../../src/trading/", import.meta.url);
    const files = readdirSync(directory, { recursive: true }).filter((name) =>
      String(name).endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const file = new URL(String(name), directory);
      const source = readFileSync(file, "utf8");
      // Self-contained primitives have no imports (including type/dynamic
      // imports), re-exports or require calls. Domain validation is external.
      expect(source, String(name)).not.toMatch(
        /\bimport\s*(?:[({*"']|type\b|[\w$]+\s)/,
      );
      expect(source, String(name)).not.toMatch(
        /\bexport\s+(?:type\s+)?(?:\*|\{)[\s\S]*?\bfrom\s*["']/,
      );
      expect(source, String(name)).not.toMatch(/\brequire\s*\(/);
    }
  });
});
