import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretValue } from "../../src/config.js";
import { createJevDecisionAdapter } from "../../src/models/jev-decision.js";
import {
  createJevBatchTransport,
  type JevBatchTransport,
} from "../../src/models/jev-decision-typesafe.js";
import {
  deriveJevResult,
  replayJevDecision,
} from "../../src/models/jev-decision-replay.js";
import {
  JEV_DECISION_VERSION,
  JEV_LIMITS,
  refusedDecisions,
  usableJevDecision,
  type JevBatchResult,
} from "../../src/models/jev-decision-contract.js";
import type { JevDecisionStore } from "../../src/storage/jev-decision-store.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { quote } from "../../src/models/jev-contract.js";
import { mockTariff } from "./jev-fixture.js";
import { decisionFixture, decisionResponse } from "./jev-decision-fixture.js";
function memoryStore(): JevDecisionStore {
  const used = new Set<string>();
  return {
    async reserve(batch, origin, tariff, refusal) {
      const reason = used.has(batch.request_id)
        ? "duplicate"
        : (refusal ?? "recovered_uncertain");
      used.add(batch.request_id);
      const at = new Date().toISOString(),
        amount =
          refusal || reason === "duplicate"
            ? "0"
            : quote(tariff ?? undefined, batch.model, batch.deadline_at)!;
      const result: JevBatchResult = {
        schema_version: JEV_DECISION_VERSION,
        origin,
        batch: structuredClone(batch),
        batch_hash: jevHash(batch),
        reason,
        attempted: amount !== "0",
        started_at: at,
        finished_at: at,
        response_received_at: null,
        http_status: null,
        original_response: null,
        response_hash: null,
        reserved_usd6: amount,
        cost_usd6: amount === "0" ? "0" : null,
        tariff,
        usage: null,
        decisions: refusedDecisions(batch, reason, amount === "0" ? "0" : null),
      };
      return refusal || reason === "duplicate"
        ? result
        : { token: "memory", result };
    },
    async finish(_reservation, result) {
      return deriveJevResult({
        ...result,
        finished_at: new Date().toISOString(),
      });
    },
  };
}
const wire = (body: string, status = 200) => ({
  body,
  status,
  received_at: new Date().toISOString(),
});
describe("principal HTTP adapter synthetic fault fixtures", () => {
  beforeEach(() => {
    const { batch } = decisionFixture();
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(batch.cut_at));
  });
  afterEach(() => vi.useRealTimers());
  it("sends one profile state with both own questions and permanently labels injected HTTP mock", async () => {
    const { batch } = decisionFixture();
    let sent: Record<string, unknown> | undefined,
      calls = 0;
    const transport = createJevBatchTransport(
      new SecretValue("synthetic-test-key"),
      batch.model,
      (async (url, options) => {
        calls++;
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(options!.redirect).toBe("error");
        sent = JSON.parse(String(options!.body)) as Record<string, unknown>;
        return new Response(` ${JSON.stringify(decisionResponse(batch))} `, {
          status: 200,
        });
      }) as typeof fetch,
    );
    const adapter = createJevDecisionAdapter({
      store: memoryStore(),
      transport,
      enabled: true,
      tariff: mockTariff(),
    });
    const r = await adapter.evaluate(batch);
    expect(r.origin).toBe("mock");
    expect(r.reason).toBe("ok");
    expect(calls).toBe(1);
    expect(sent!.questions).toEqual(batch.questions);
    expect(replayJevDecision(r)).toEqual(r);
    expect(
      usableJevDecision(
        r,
        batch.participants[0]!.context.scope,
        batch.participants[0]!.context.account,
        batch.cut_at,
      ),
    ).toBeNull();
    expect(await adapter.evaluate(batch)).toHaveProperty("reason", "duplicate");
    expect(calls).toBe(1);
  });
  it("keeps valid account on partial error and diagnostic confidence never gates choices", async () => {
    const { batch } = decisionFixture(),
      raw = decisionResponse(batch);
    delete raw.answers.a1_intent;
    raw.answers.a0_intent!.confidence = 0;
    const adapter = createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport: {
        origin: "real",
        model: batch.model,
        async evaluate() {
          return wire(JSON.stringify(raw));
        },
      },
    });
    const r = await adapter.evaluate(batch);
    expect(r.reason).toBe("partial_error");
    expect(r.decisions.map((d) => d.action)).toEqual(["open", null]);
    expect(
      usableJevDecision(
        r,
        batch.participants[0]!.context.scope,
        batch.participants[0]!.context.account,
        batch.cut_at,
      )?.action,
    ).toBe("open");
    expect(
      usableJevDecision(
        r,
        batch.participants[0]!.context.scope,
        { ...batch.participants[0]!.context.account!, cash_usd_raw: "1" },
        batch.cut_at,
      ),
    ).toBeNull();
    expect(
      usableJevDecision(
        r,
        batch.participants[0]!.context.scope,
        batch.participants[0]!.context.account,
        batch.expires_at,
      ),
    ).toBeNull();
  });
  it("unknown usage cannot release any action but preserves the exact original", async () => {
    const { batch } = decisionFixture();
    const raw = {
      ...decisionResponse(batch),
      usage: { input_tokens: 65537, output_tokens: 1 },
    };
    const original = JSON.stringify(raw);
    const r = await createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport: {
        origin: "mock",
        model: batch.model,
        async evaluate() {
          return wire(original);
        },
      },
    }).evaluate(batch);
    expect(r).toMatchObject({
      reason: "cost_unknown",
      original_response: original,
      cost_usd6: null,
    });
    expect(r.decisions.every((d) => d.action === null)).toBe(true);
    expect(replayJevDecision(r)).toEqual(r);
    expect(() => replayJevDecision({ ...r, original_response: "{}" })).toThrow(
      /RESPONSE_HASH/,
    );
  });
  it("timeout absorbs late responses, preserves unknown reservation and never invents hold", async () => {
    const { batch } = decisionFixture();
    let resolve!: (v: ReturnType<typeof wire>) => void;
    const transport: JevBatchTransport = {
      origin: "mock",
      model: batch.model,
      evaluate: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    const run = createJevDecisionAdapter({
      store: memoryStore(),
      transport,
      enabled: true,
      tariff: mockTariff(),
    }).evaluate(batch);
    await vi.advanceTimersByTimeAsync(1500);
    const r = await run;
    expect(r.reason).toBe("timeout");
    expect(r.cost_usd6).toBeNull();
    expect(r.decisions.every((d) => d.action === null)).toBe(true);
    resolve(wire(JSON.stringify(decisionResponse(batch))));
    await vi.advanceTimersByTimeAsync(1);
    expect(r.original_response).toBeNull();
    expect(replayJevDecision(r)).toEqual(r);
  });
  it("cancel after dispatch is uncertain; cancellation before dispatch is known zero", async () => {
    const { batch } = decisionFixture();
    const controller = new AbortController();
    let sent = 0;
    const adapter = createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport: {
        origin: "mock",
        model: batch.model,
        evaluate() {
          sent++;
          return new Promise(() => {});
        },
      },
    });
    const run = adapter.evaluate(batch, controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await run).toMatchObject({ reason: "cancelled", cost_usd6: null });
    expect(sent).toBe(1);
    expect(
      await adapter.evaluate(
        { ...batch, request_id: "before" },
        controller.signal,
      ),
    ).toMatchObject({ reason: "cancelled", cost_usd6: "0", attempted: false });
    expect(sent).toBe(1);
  });
  it("429 is one attempt, records billing separately and never retries", async () => {
    const { batch } = decisionFixture();
    let calls = 0;
    const transport = createJevBatchTransport(
      new SecretValue("synthetic-test-key"),
      batch.model,
      (async () => {
        calls++;
        return new Response(JSON.stringify(decisionResponse(batch)), {
          status: 429,
        });
      }) as typeof fetch,
    );
    const r = await createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport,
    }).evaluate(batch);
    expect(r).toMatchObject({
      reason: "rate_limited",
      http_status: 429,
      cost_usd6: "42",
    });
    expect(r.decisions.every((d) => d.action === null)).toBe(true);
    expect(calls).toBe(1);
  });
  it("network failure, invalid binding and oversized response fail closed", async () => {
    const { batch } = decisionFixture();
    for (const [body, reason] of [
      ["x".repeat(JEV_LIMITS.response_bytes + 1), "oversized_response"],
      [
        JSON.stringify({
          ...decisionResponse(batch),
          answers: { unexpected: {} },
        }),
        "binding_error",
      ],
    ] as const) {
      const transport = createJevBatchTransport(
        new SecretValue("synthetic-test-key"),
        batch.model,
        (async () => new Response(body)) as typeof fetch,
      );
      const r = await createJevDecisionAdapter({
        store: memoryStore(),
        enabled: true,
        tariff: mockTariff(),
        transport,
      }).evaluate(batch);
      expect(r.reason).toBe(reason);
      expect(r.decisions.every((d) => d.action === null)).toBe(true);
    }
    const r = await createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport: {
        origin: "mock",
        model: batch.model,
        async evaluate() {
          throw Error("sensitive-provider-data");
        },
      },
    }).evaluate(batch);
    expect(r.reason).toBe("provider_error");
    expect(JSON.stringify(r)).not.toContain("sensitive-provider-data");
  });
  it("rejects duplicate escaped answer keys while preserving unambiguous billing", async () => {
    const { batch } = decisionFixture(),
      response = JSON.stringify(decisionResponse(batch));
    const duplicate = response.replace(
      '"answers":{',
      '"answers":{},"\\u0061nswers":{',
    );
    const r = await createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport: {
        origin: "mock",
        model: batch.model,
        async evaluate() {
          return wire(duplicate);
        },
      },
    }).evaluate(batch);
    expect(r.reason).toBe("binding_error");
    expect(r.cost_usd6).toBe("42");
    expect(r.decisions.every((d) => d.action === null)).toBe(true);
    const billing = response.replace(
      '"input_tokens":1000',
      '"input_tokens":1,"input_tokens":1000',
    );
    const u = await createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport: {
        origin: "mock",
        model: batch.model,
        async evaluate() {
          return wire(billing);
        },
      },
    }).evaluate(batch);
    expect(u.cost_usd6).toBeNull();
    expect(u.reason).toBe("cost_unknown");
  });
  it("duplicate fields inside a known answer refuse only its account", async () => {
    const { batch } = decisionFixture();
    const original = JSON.stringify(decisionResponse(batch)).replace(
      '"a1_intent":{"type":"choice"',
      '"a1_intent":{"type":"noul","type":"choice"',
    );
    const r = await createJevDecisionAdapter({
      store: memoryStore(),
      enabled: true,
      tariff: mockTariff(),
      transport: {
        origin: "mock",
        model: batch.model,
        async evaluate() {
          return wire(original);
        },
      },
    }).evaluate(batch);
    expect(r.reason).toBe("partial_error");
    expect(r.decisions.map((d) => d.reason)).toEqual([
      "ok",
      "malformed_response",
    ]);
    expect(r.cost_usd6).toBe("42");
    expect(replayJevDecision(r)).toEqual(r);
  });
  it("keeps disabled/missing tariff requests unsent and snapshots caller mutation", async () => {
    const { batch } = decisionFixture();
    let sent = 0;
    const transport: JevBatchTransport = {
      origin: "mock",
      model: batch.model,
      async evaluate(b) {
        sent++;
        return wire(JSON.stringify(decisionResponse(b)));
      },
    };
    for (const options of [
      { enabled: false, tariff: mockTariff() },
      { enabled: true },
    ]) {
      const r = await createJevDecisionAdapter({
        store: memoryStore(),
        transport,
        ...options,
      }).evaluate(batch);
      expect(r.attempted).toBe(false);
      expect(r.decisions.every((d) => d.action === null)).toBe(true);
    }
    expect(sent).toBe(0);
    const adapter = createJevDecisionAdapter({
      store: memoryStore(),
      transport,
      enabled: true,
      tariff: mockTariff(),
    });
    const run = adapter.evaluate(batch);
    batch.participants[0]!.context.account!.cash_usd_raw = "1";
    const r = await run;
    expect(r.batch.participants[0]!.context.account!.cash_usd_raw).toBe(
      "250000000",
    );
  });
});
