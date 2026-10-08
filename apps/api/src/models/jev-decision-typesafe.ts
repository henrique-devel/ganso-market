import type { SecretValue } from "../config.js";
import {
  jevBatchPayload,
  validateJevBatch,
  JEV_LIMITS,
  type JevBatch,
  type JevFailure,
} from "./jev-decision-contract.js";
export interface JevBatchWire {
  body: string;
  status: number;
  received_at: string;
}
export interface JevBatchTransport {
  readonly origin: "real" | "mock";
  readonly model: string;
  evaluate(batch: JevBatch, signal: AbortSignal): Promise<JevBatchWire>;
}
export class JevTransportFailure extends Error {
  constructor(readonly reason: JevFailure) {
    super(reason);
  }
}
/** Exactly one bounded HTTP attempt; test injection fixes origin to mock. */
export function createJevBatchTransport(
  key: SecretValue,
  model: string,
  testFetch?: typeof fetch,
): JevBatchTransport {
  const send = testFetch ?? fetch;
  return Object.freeze({
    origin: testFetch ? ("mock" as const) : ("real" as const),
    model,
    async evaluate(batch: JevBatch, signal: AbortSignal) {
      validateJevBatch(batch);
      if (batch.model !== model) throw new JevTransportFailure("binding_error");
      const response = await key.use((secret) =>
        send("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(jevBatchPayload(batch)),
        }),
      );
      if (!response.body)
        return {
          body: "",
          status: response.status,
          received_at: new Date().toISOString(),
        };
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > JEV_LIMITS.response_bytes)
            throw new JevTransportFailure("oversized_response");
          if (signal.aborted) throw new JevTransportFailure("cancelled");
          chunks.push(value);
        }
        return {
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.status,
          received_at: new Date().toISOString(),
        };
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  });
}
