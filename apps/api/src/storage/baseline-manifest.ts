import { createHash } from "node:crypto";
import { BAR_BUILD_VERSION, BAR_LIMITS } from "../trading/bars.js";
import { BROKER_VERSION } from "../trading/broker.js";
import {
  FUNDING_VERSION,
  PAPER_FUNDING_MODEL,
  PAPER_FUNDING_MAX_RECEIPT_AGE_MS,
} from "../trading/funding.js";
import { LEDGER_VERSION } from "../trading/ledger.js";
import { MARGIN_VERSION } from "../trading/margin.js";
import { RESERVATION_VERSION } from "../trading/reservations.js";
import { RISK_POLICY } from "../trading/risk.js";
import { VALUATION_VERSION } from "../trading/valuation.js";
import { HYPERLIQUID_REFERENCE } from "../venues/hyperliquid/reference.js";

// This allowlist freezes one reviewed experiment, not a parameter optimizer.
// New semantics require a new policy/manifest version and prospective registration.
export const BASELINE_FINGERPRINT =
  "sha256:c6a88d9d267f626b8ad233db1ab557de87130fbf6b21d5e08e7be662cec8ceda";

function requireManifest(ok: boolean, code: string): asserts ok {
  if (!ok) throw new TypeError(`BTC_BASELINE_${code}`);
}

/** sorted-json-safe-integers.v1: preserve array order; no coercion or floats. */
export function canonicalBaselineJson(value: unknown, depth = 0): string {
  requireManifest(depth <= 16, "JSON_DEPTH");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    requireManifest(
      Number.isSafeInteger(value) && !Object.is(value, -0),
      "JSON_NUMBER",
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${Array.from(value, (item) => canonicalBaselineJson(item, depth + 1)).join(",")}]`;
  requireManifest(
    typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype,
    "JSON_OBJECT",
  );
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalBaselineJson(record[key], depth + 1)}`,
    )
    .join(",")}}`;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** JSON.parse alone discards duplicate keys. Tokenize already-valid JSON to
 * reject them before trusting its semantic fingerprint (including escaped keys). */
function parseManifest(source: string): unknown {
  requireManifest(Buffer.byteLength(source, "utf8") <= 65_536, "JSON_SIZE");
  const value: unknown = JSON.parse(source);
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const keys = stack.at(-1);
      const key = JSON.parse(token) as string;
      requireManifest(!!keys && !keys.has(key), "DUPLICATE_KEY");
      keys.add(key);
    }
  }
  return value;
}

/** No I/O, clock, activation, account writes, signal or broker invocation.
 * Returns immutable canonical bytes to pin, never a mutable config reference.
 * Caller supplies the UTF-8 config and normative contract from the same release. */
export function validateBaselineManifest(source: string, contract: string) {
  const value = parseManifest(source);
  const canonical_json = canonicalBaselineJson(value);
  const fingerprint = `sha256:${sha256(canonical_json)}`;
  requireManifest(fingerprint === BASELINE_FINGERPRINT, "NOT_FROZEN");
  // Shape is authenticated by the exact reviewed semantic hash above.
  const m = value as Record<string, Record<string, unknown>>;
  requireManifest(m.contract!.sha256 === sha256(contract), "CONTRACT_HASH");
  const same = (actual: unknown, expected: unknown) =>
    requireManifest(actual === expected, "RUNTIME_CONTRACT_DRIFT");
  for (const [key, value] of Object.entries(RISK_POLICY)) {
    same(
      key === "mark_age_ms" || key === "book_age_ms"
        ? m.data![key]
        : m.risk![key],
      value,
    );
  }
  same(m.data!.bar_build, BAR_BUILD_VERSION);
  same(m.data!.lateness_ms, BAR_LIMITS.latenessMs);
  same(m.execution!.model, BROKER_VERSION);
  same(m.funding!.model, PAPER_FUNDING_MODEL);
  same(m.funding!.envelope, FUNDING_VERSION);
  same(m.funding!.max_receipt_age_ms, PAPER_FUNDING_MAX_RECEIPT_AGE_MS);
  same(m.accounting!.ledger, LEDGER_VERSION);
  same(m.accounting!.reservation, RESERVATION_VERSION);
  same(m.accounting!.margin, MARGIN_VERSION);
  same(m.accounting!.valuation, VALUATION_VERSION);
  same(m.data!.metadata_reference, HYPERLIQUID_REFERENCE.version);
  same(HYPERLIQUID_REFERENCE.taker_rate, "0.00045");
  return Object.freeze({ fingerprint, canonical_json });
}
