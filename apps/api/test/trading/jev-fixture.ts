import type {
  JevRequest,
  JevTariff,
  JevDecision,
} from "../../src/models/jev-contract.js";
/** Synthetic observations and provider responses. NEVER market/model evidence. */
export const mockTariff = (): JevTariff => ({
  version: "mock-tariff.v1",
  model: "jev-1.13.0",
  valid_until: new Date(Date.now() + 86_400_000).toISOString(),
  input_usd6_per_million: "42000",
  output_usd6_per_million: "0",
  max_billable_input_tokens: 65_536,
});
export const mockRequest = (id = "mock:1", window = 10_000): JevRequest => ({
  request_id: id,
  deadline_at: new Date(Date.now() + window).toISOString(),
  input: {
    candidate_hash: `sha256:${"a".repeat(64)}`,
    direction: "long",
    close_usd6: "65000000000",
    fast_mean_usd6: "64000000000",
    slow_mean_usd6: "63000000000",
    atr_usd6: "500000000",
  },
});
export const mockResponse = (decision: JevDecision = "allow") => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 1000, output_tokens: 20 },
  answers: {
    filter: {
      type: "choice",
      choice: decision,
      confidence: 1,
      probabilities: {
        allow: decision === "allow" ? 1 : 0,
        veto: decision === "veto" ? 1 : 0,
        abstain: decision === "abstain" ? 1 : 0,
      },
    },
  },
});
