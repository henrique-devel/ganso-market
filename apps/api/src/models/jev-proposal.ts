import { createHash } from "node:crypto";
import type { SecretValue } from "../config.js";
import { keys, record, usageCost, type JevTariff } from "./jev-contract.js";
import { parseJevResponseJson } from "./jev-response-json.js";
export const JEV_PROPOSAL_POLICY = Object.freeze({
  version: "jev.proposal-validation.v1",
  minimum_closed_episodes_per_account: 1,
  deadline_ms: 1500,
  response_bytes: 65536,
});
export const JEV_PROPOSAL_QUESTION = Object.freeze({
  type: "choice",
  instructions:
    "Judge the technical coherence of `state.proposal` as a one-component successor to `state.parent`. Use only the supplied closed history. Assess whether information and economic horizon can support the declared JEV decisions with the fixed risk/execution contract. This is not a profitability prediction or economic approval. Abstain when the evidence cannot establish technical aptitude.",
  criteria: {
    strong:
      "Technically coherent with clear compatibility of data window, information and economic horizon.",
    adequate: "Technically coherent and usable within the fixed contract.",
    veto: "Technically contradictory or unsuitable for the declared decision workflow.",
    abstain:
      "Insufficient or ambiguous information to establish technical coherence.",
  },
});
export interface ProposalWire {
  body: string;
  status: number;
  received_at: string;
}
export interface ProposalTransport {
  origin: "real" | "mock";
  model: string;
  evaluate(payload: unknown, signal: AbortSignal): Promise<ProposalWire>;
}
export function createProposalTransport(
  key: SecretValue,
  model: string,
  testFetch?: typeof fetch,
): ProposalTransport {
  const send = testFetch ?? fetch;
  return {
    origin: testFetch ? "mock" : "real",
    model,
    async evaluate(payload, signal) {
      const r = await key.use((secret) =>
        send("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
      const reader = r.body?.getReader();
      let body = "";
      if (reader) {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const v = await reader.read();
            if (v.done) break;
            bytes += v.value.byteLength;
            if (bytes > JEV_PROPOSAL_POLICY.response_bytes)
              throw new Error("oversized_response");
            chunks.push(v.value);
          }
          body = Buffer.concat(chunks).toString("utf8");
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      return { body, status: r.status, received_at: new Date().toISOString() };
    },
  };
}
export function deriveProposalResult(
  wire: ProposalWire | null,
  tariff: JevTariff,
  deadline: string,
  failure = "provider_error",
) {
  let raw: unknown = null,
    invalidJudgment = false,
    billingAmbiguous = false;
  try {
    if (wire) {
      const parsed = parseJevResponseJson(wire.body);
      raw = parsed.value;
      invalidJudgment =
        parsed.ambiguous || parsed.invalidQuestions.includes("aptitude");
      billingAmbiguous = parsed.billingAmbiguous;
    }
  } catch {
    /* Preserve malformed response; billing stays independently unknown. */
  }
  const bill = billingAmbiguous ? null : usageCost(raw, tariff),
    r = record(raw),
    answers = record(r?.answers),
    a = record(answers?.aptitude),
    p = record(a?.probabilities),
    options = ["strong", "adequate", "veto", "abstain"];
  const prob = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  let reason = failure,
    rank: number | null = null,
    judgment: unknown = null;
  if (wire) {
    reason =
      wire.status !== 200
        ? "provider_error"
        : !Number.isFinite(Date.parse(wire.received_at)) ||
            !Number.isFinite(Date.parse(deadline)) ||
            Date.parse(wire.received_at) > Date.parse(deadline)
          ? "timeout"
          : !bill
            ? "cost_unknown"
            : "malformed_response";
    if (
      reason === "malformed_response" &&
      !invalidJudgment &&
      r &&
      keys(r, ["model", "answers", "usage"]) &&
      answers &&
      keys(answers, ["aptitude"]) &&
      a &&
      keys(a, ["type", "choice", "confidence", "probabilities"]) &&
      a.type === "choice" &&
      options.includes(String(a.choice)) &&
      prob(a.confidence) &&
      p &&
      keys(p, options) &&
      options.every((k) => prob(p[k])) &&
      Math.abs(options.reduce((n, k) => n + Number(p[k]), 0) - 1) <= 0.000001 &&
      options.every((k) => Number(p[k]) <= Number(p[String(a.choice)]))
    ) {
      reason = "ok";
      judgment = a;
      rank = a.choice === "strong" ? 2 : a.choice === "adequate" ? 1 : 0;
    }
  }
  return {
    reason,
    rank,
    judgment,
    cost_usd6: bill?.cost ?? null,
    usage: bill?.usage ?? null,
    original_response: wire?.body ?? null,
    response_hash: wire
      ? createHash("sha256").update(wire.body).digest("hex")
      : null,
  };
}
