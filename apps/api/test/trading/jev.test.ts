import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretValue } from "../../src/config.js";
import { createJevAdapter } from "../../src/models/jev.js";
import { createTypeSafeTransport } from "../../src/models/jev-typesafe.js";
import {
  jevHash,
  quote,
  validateAnswer,
  usageCost,
  type JevTransport,
} from "../../src/models/jev-contract.js";
import type { JevStore } from "../../src/storage/jevstore.js";
import { mockRequest, mockResponse, mockTariff } from "./jev-fixture.js";

function fixture(
  evaluate = vi
    .fn<JevTransport["evaluate"]>()
    .mockResolvedValue(mockResponse()),
) {
  const store: JevStore = {
    reserve: vi.fn(async (result) => ({
      token: "mock-fence",
      result: { ...result, attempted: true },
    })),
    finish: vi.fn(async (_r, result) => result),
  };
  const transport: JevTransport = {
    origin: "mock",
    model: "jev-1.13.0",
    evaluate,
  };
  const tariff = mockTariff();
  const options = { store, transport, tariff, enabled: true };
  return { store, transport, options, adapter: createJevAdapter(options) };
}
afterEach(() => vi.useRealTimers());
describe("Jev adapter — declared mocks only", () => {
  it("defaults disabled even when a transport, key and tariff exist", async () => {
    const f = fixture();
    const result = await createJevAdapter({
      ...f.options,
      enabled: undefined,
    }).evaluate(mockRequest());
    expect(result).toMatchObject({
      reason: "disabled",
      attempted: false,
      decision: "abstain",
      origin: "mock",
      cost_usd6: "0",
    });
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.transport.evaluate).not.toHaveBeenCalled();
  });
  it.each(["allow", "veto", "abstain"] as const)(
    "returns only validated %s and measured provenance",
    async (decision) => {
      const f = fixture(vi.fn().mockResolvedValue(mockResponse(decision))),
        req = mockRequest();
      const result = await f.adapter.evaluate(req);
      expect(result).toMatchObject({
        decision,
        reason: "ok",
        origin: "mock",
        attempted: true,
        input_hash: jevHash(req.input),
        model: "jev-1.13.0",
        tariff_version: "mock-tariff.v1",
        cost_usd6: "42",
        reserved_usd6: "2753",
        deadline_at: req.deadline_at,
      });
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(f.transport.evaluate).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { model: "wrong" },
    { answers: {} },
    { size: "1000" },
    {
      answers: {
        filter: { ...mockResponse().answers.filter, direction: "short" },
      },
    },
    {
      answers: {
        filter: {
          ...mockResponse().answers.filter,
          probabilities: { allow: 1, veto: 1, abstain: 0 },
        },
      },
    },
    {
      answers: { filter: { ...mockResponse().answers.filter, choice: "long" } },
    },
    {
      answers: {
        filter: { ...mockResponse().answers.filter, confidence: Number.NaN },
      },
    },
  ])("rejects malformed or authority-expanding outputs %j", async (patch) => {
    const raw = { ...mockResponse(), ...patch };
    expect(validateAnswer(raw, "jev-1.13.0")).toBeNull();
    const f = fixture(vi.fn().mockResolvedValue(raw));
    expect(await f.adapter.evaluate(mockRequest())).toMatchObject({
      decision: "abstain",
      answer: null,
    });
  });
  it("unknown usage retains the maximum and opens the circuit; no free assumption", async () => {
    const f = fixture(
      vi.fn().mockResolvedValue({ ...mockResponse(), usage: {} }),
    );
    expect(await f.adapter.evaluate(mockRequest())).toMatchObject({
      reason: "cost_unknown",
      cost_usd6: null,
      decision: "abstain",
    });
    expect(f.store.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
    );
    expect(
      usageCost(
        {
          ...mockResponse(),
          usage: { input_tokens: 65_537, output_tokens: 0 },
        },
        mockTariff(),
      ),
    ).toBeNull();
  });
  it("refuses missing/expired tariff, floating model alias and unknown pre-call cost", async () => {
    const f = fixture();
    for (const tariff of [
      undefined,
      { ...f.options.tariff, valid_until: "2020-01-01T00:00:00.000Z" },
      { ...f.options.tariff, input_usd6_per_million: "0" },
      { ...f.options.tariff, max_billable_input_tokens: 1000 },
    ]) {
      expect(
        (
          await createJevAdapter({ ...f.options, tariff }).evaluate(
            mockRequest(),
          )
        ).reason,
      ).toBe("cost_unknown");
    }
    expect(
      quote(f.options.tariff, "jev-latest", mockRequest().deadline_at),
    ).toBeNull();
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.transport.evaluate).not.toHaveBeenCalled();
  });
  it("malformed answer still settles known billable usage", async () => {
    const f = fixture(
      vi.fn().mockResolvedValue({ ...mockResponse(), answers: {} }),
    );
    expect(await f.adapter.evaluate(mockRequest())).toMatchObject({
      reason: "malformed_response",
      cost_usd6: "42",
      decision: "abstain",
    });
  });
  it("transport rejection is one attempt with possibly incurred cost; error secrets are discarded", async () => {
    const f = fixture(
      vi.fn().mockRejectedValue(new Error("synthetic-secret-do-not-record")),
    );
    const r = await f.adapter.evaluate(mockRequest());
    expect(r).toMatchObject({
      reason: "provider_error",
      cost_usd6: null,
      reserved_usd6: "2753",
    });
    expect(JSON.stringify(r)).not.toContain("synthetic-secret");
    expect(f.transport.evaluate).toHaveBeenCalledOnce();
  });
  it("aborts deadline and ignores late success and rejection without a second settlement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (const reject of [false, true]) {
      let complete!: (v: unknown) => void;
      const f = fixture(
        vi.fn(
          (_input, _signal) =>
            new Promise((resolve, fail) => {
              complete = reject ? fail : resolve;
            }),
        ),
      );
      const p = f.adapter.evaluate(mockRequest("mock:late", 100));
      await vi.advanceTimersByTimeAsync(101);
      const r = await p;
      expect(r).toMatchObject({
        reason: "timeout",
        decision: "abstain",
        cost_usd6: null,
      });
      expect(vi.mocked(f.transport.evaluate).mock.calls[0]![1].aborted).toBe(
        true,
      );
      complete(reject ? new Error("late") : mockResponse());
      await vi.advanceTimersByTimeAsync(1);
      expect(f.store.finish).toHaveBeenCalledOnce();
      expect(r.reason).toBe("timeout");
    }
  });
  it("cancels before dispatch and in flight without inferring a refund", async () => {
    const pre = new AbortController();
    pre.abort();
    const f = fixture();
    expect((await f.adapter.evaluate(mockRequest(), pre.signal)).reason).toBe(
      "cancelled",
    );
    expect(f.store.reserve).not.toHaveBeenCalled();
    const flight = new AbortController();
    const g = fixture(
      vi.fn(async () => {
        flight.abort();
        return mockResponse();
      }),
    );
    expect(
      await g.adapter.evaluate(mockRequest(), flight.signal),
    ).toMatchObject({ reason: "cancelled", cost_usd6: null });
  });
  it("snapshots input before reserving, and storage/fence failures abstain", async () => {
    const f = fixture(),
      req = mockRequest(),
      before = { ...req.input };
    const p = f.adapter.evaluate(req);
    req.input.direction = "short";
    expect((await p).input_hash).toBe(jevHash(before));
    expect(f.transport.evaluate).toHaveBeenCalledWith(
      before,
      expect.any(AbortSignal),
    );
    vi.mocked(f.store.finish).mockRejectedValueOnce(new Error("fence"));
    expect(await f.adapter.evaluate(mockRequest())).toMatchObject({
      reason: "storage_error",
      decision: "abstain",
      cost_usd6: null,
    });
    vi.mocked(f.store.reserve).mockRejectedValueOnce(
      new Error("uncertain commit"),
    );
    expect((await f.adapter.evaluate(mockRequest())).reason).toBe(
      "storage_error",
    );
  });
  it("returns abstain if persistence finishes after deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture(),
      req = mockRequest();
    vi.mocked(f.store.finish).mockImplementationOnce(async (_r, result) => {
      vi.setSystemTime(Date.parse(req.deadline_at));
      return result;
    });
    expect(await f.adapter.evaluate(req)).toMatchObject({
      reason: "timeout",
      decision: "abstain",
      answer: null,
    });
  });
  it("never sends on duplicate, exhausted budget or open circuit", async () => {
    const f = fixture();
    for (const reason of [
      "duplicate",
      "budget_exhausted",
      "circuit_open",
      "budget_unavailable",
    ] as const) {
      vi.mocked(f.store.reserve).mockResolvedValueOnce(reason);
      expect(await f.adapter.evaluate(mockRequest())).toMatchObject({
        reason,
        decision: "abstain",
        attempted: false,
        cost_usd6: "0",
      });
    }
    expect(f.transport.evaluate).not.toHaveBeenCalled();
  });
});
describe("TypeSafe wire contract with mock HTTP", () => {
  it("uses a fixed endpoint, one restricted choice, pinned model and redacted backend secret", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(mockResponse())));
    const key = new SecretValue("mock-key");
    const transport = createTypeSafeTransport(key, "jev-1.13.0", send);
    const result = await transport.evaluate(
      mockRequest().input,
      new AbortController().signal,
    );
    expect(result).toEqual({ body: JSON.stringify(mockResponse()) });
    expect(transport.origin).toBe("mock");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toBe("https://api.typesafe.ai/v1/systemone");
    const options = send.mock.calls[0]![1]!;
    expect(options.redirect).toBe("error");
    expect(
      JSON.parse(options.body as string).questions.filter.criteria,
    ).toHaveProperty("abstain");
    expect(JSON.stringify(key)).not.toContain("mock-key");
  });
  it.each([429, 529, 401, 500])("does not retry HTTP %s", async (status) => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("mock provider error", { status }));
    await expect(
      createTypeSafeTransport(
        new SecretValue("mock-key"),
        "jev-1.13.0",
        send,
      ).evaluate(mockRequest().input, new AbortController().signal),
    ).rejects.toThrow("JEV_HTTP_ERROR");
    expect(send).toHaveBeenCalledOnce();
  });
  it("bounds response bytes", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(" ".repeat(16_385)));
    await expect(
      createTypeSafeTransport(
        new SecretValue("mock-key"),
        "jev-1.13.0",
        send,
      ).evaluate(mockRequest().input, new AbortController().signal),
    ).rejects.toThrow("JEV_RESPONSE_REJECTED");
  });
});
