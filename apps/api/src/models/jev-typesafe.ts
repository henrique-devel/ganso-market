import type { SecretValue } from "../config.js";
import { JEV_QUESTION, type JevTransport } from "./jev-contract.js";

/** Direct HTTP avoids the SDK's default retry policy. Endpoint is fixed so a
 * config typo cannot send the backend secret to another host. Supplying a test
 * fetch permanently labels this transport mock. No key is read from env here. */
export function createTypeSafeTransport(
  key: SecretValue,
  model: string,
  testFetch?: typeof fetch,
): JevTransport {
  const send = testFetch ?? fetch;
  return Object.freeze({
    origin: testFetch ? ("mock" as const) : ("real" as const),
    model,
    async evaluate(input, signal) {
      const response = await key.use((secret) =>
        send("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            state: input,
            questions: { filter: JEV_QUESTION },
          }),
        }),
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("JEV_HTTP_ERROR");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16_384 || signal.aborted)
            throw new Error("JEV_RESPONSE_REJECTED");
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  } satisfies JevTransport);
}
