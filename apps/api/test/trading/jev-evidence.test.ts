import { describe, expect, it } from "vitest";
import {
  makeJevEvidence,
  validateJevEvidence,
} from "../../src/storage/jev-evidence.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { jevIdentity, iso, start } from "./jev-v2-fixture.js";
describe("minimum original JEV evidence", () => {
  const base = () => ({
    object_id: "response1",
    kind: "response" as const,
    scope: jevScope(
      jevIdentity().bindings[0]!.binding,
      jevIdentity().instrument,
    ),
    recorded_at: iso(start + 2000),
    dependencies: [],
    sources: [],
    payload: {
      request_id: "request1",
      model: "jev-1.13.0",
      outcome: "received",
      original_body: ' {"choice":"hold","usage":{"input_tokens":123}}\n',
    },
  });
  it("keeps bytes and hash of original responses, even whitespace", () => {
    const input = base(),
      e = makeJevEvidence(input);
    expect(e.payload.original_body).toBe(input.payload.original_body);
    e.payload.original_body = "changed";
    expect(() => validateJevEvidence(e)).toThrow("HASH");
  });
  it("records failure as failure; rejects a received response with no body", () => {
    const b = base();
    expect(() =>
      makeJevEvidence({
        ...b,
        payload: { ...b.payload, outcome: "timeout", original_body: null },
      }),
    ).not.toThrow();
    expect(() =>
      makeJevEvidence({ ...b, payload: { ...b.payload, original_body: null } }),
    ).toThrow("RESPONSE_BODY");
  });
  it("rejects missing decision dependencies, unknown versions and lossy JSON", () => {
    const b = base();
    expect(() =>
      makeJevEvidence({
        ...b,
        kind: "decision",
        payload: {
          request_id: "request1",
          action: "hold",
          question: {},
          original_decision: {},
          context_id: "context1",
          response_id: "response1",
        },
      }),
    ).toThrow("REQUIRED_EDGE");
    const e = makeJevEvidence(b);
    expect(() =>
      validateJevEvidence({
        ...e,
        schema_version: "unknown" as typeof e.schema_version,
      }),
    ).toThrow("ENVELOPE");
    expect(() =>
      makeJevEvidence({ ...b, payload: { omitted: undefined } }),
    ).toThrow("INVALID_JSON");
  });
});
