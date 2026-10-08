import { describe, it, expect } from "vitest";
import {
  interpretJevBatch,
  validateJevBatch,
  jevBatchPayload,
} from "../../src/models/jev-decision-contract.js";
import { decisionFixture, decisionResponse } from "./jev-decision-fixture.js";
describe("principal JEV contract, synthetic only", () => {
  it("binds complete question text to own account/position/cut/version and needs no candidate", () => {
    const { batch } = decisionFixture();
    expect(JSON.stringify(jevBatchPayload(batch))).not.toContain("candidate");
    expect(batch.questions.a0_intent!.instructions).toContain("paper:h1");
    expect(batch.questions.a1_intent!.instructions).toContain(
      "position:stress",
    );
    const response = decisionResponse(batch);
    response.answers.a0_direction!.confidence = 0;
    expect(
      interpretJevBatch(batch, response, "42").map((d) => [
        d.action,
        d.attributed_cost_usd6,
      ]),
    ).toEqual([
      ["open", "42"],
      ["close", "42"],
    ]);
    expect(
      Object.keys(interpretJevBatch(batch, response, "42")[0]!),
    ).not.toContain("quantity");
  });
  it("keeps localized missing/invalid/contradictory answers isolated", () => {
    const { batch } = decisionFixture(),
      response = decisionResponse(batch);
    delete response.answers.a1_intent;
    expect(
      interpretJevBatch(batch, response, "42").map((d) => d.reason),
    ).toEqual(["ok", "malformed_response"]);
    response.answers.a0_intent!.choice = "close";
    response.answers.a0_intent!.probabilities = { open: 0, hold: 0, close: 1 };
    expect(interpretJevBatch(batch, response, "42")[0]!.reason).toBe(
      "incompatible_position",
    );
  });
  it("rejects unowned answers, manipulated question text, duplicate account and mixed profiles/sources", () => {
    const { batch } = decisionFixture(),
      response = decisionResponse(batch);
    response.answers.unowned = response.answers.a0_direction!;
    expect(
      interpretJevBatch(batch, response, "42").every(
        (d) => d.reason === "binding_error",
      ),
    ).toBe(true);
    for (const mutate of [
      (b: typeof batch) => {
        b.questions.a0_intent!.instructions = "Use another account";
      },
      (b: typeof batch) => {
        b.participants[1]!.context.scope.profile_id = "other";
      },
      (b: typeof batch) => {
        b.participants[1]!.context.input_refs[0]!.payload_hash = "f".repeat(64);
      },
      (b: typeof batch) => {
        b.participants[1] = structuredClone(b.participants[0]!);
      },
    ]) {
      const changed = structuredClone(batch);
      mutate(changed);
      expect(() => validateJevBatch(changed)).toThrow();
    }
  });
  it("rejects aliases, stale/incomplete state, oversized input and >1.5s deadline", () => {
    const { batch } = decisionFixture();
    for (const mutate of [
      (b: typeof batch) => {
        b.model = "jev-latest";
      },
      (b: typeof batch) => {
        b.deadline_at = new Date(Date.parse(b.cut_at) + 1501).toISOString();
      },
      (b: typeof batch) => {
        b.participants[0]!.context.quality.state = "incomplete";
      },
      (b: typeof batch) => {
        b.participants[0]!.context.input_refs[0]!.object_id = "x".repeat(70000);
      },
    ]) {
      const changed = structuredClone(batch);
      mutate(changed);
      expect(() => validateJevBatch(changed)).toThrow();
    }
  });
});
