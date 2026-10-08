#!/usr/bin/env node
// Opt-in connectivity probe: one synthetic request, no trading or runtime changes.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const secretDirectory = new URL("../infra/secrets/local", import.meta.url);
const secretPath = new URL(
  "../infra/secrets/local/jev_api_key",
  import.meta.url,
);
const endpoint = "https://api.typesafe.ai/v1/systemone";
const model = "jev-1.13.0";

class ProbeFailure extends Error {}

async function readSecret() {
  const directory = await lstat(secretDirectory);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
    throw new ProbeFailure("SECRET_DIRECTORY_UNSAFE");
  const file = await open(
    secretPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const status = await file.stat();
    if (
      !status.isFile() ||
      (status.mode & 0o077) !== 0 ||
      status.size < 16 ||
      status.size > 4096
    )
      throw new ProbeFailure("SECRET_FILE_UNSAFE");
    const key = (await file.readFile("utf8")).trim();
    if (!key || /\s/.test(key)) throw new ProbeFailure("SECRET_FILE_INVALID");
    return key;
  } finally {
    await file.close();
  }
}

async function readBoundedBody(response) {
  if (!response.body) throw new ProbeFailure("JEV_EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) throw new ProbeFailure("JEV_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function main() {
  const key = await readSecret();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      state:
        "Synthetic support message: I need help immediately; my test account is unavailable.",
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Does this message convey urgency?",
        },
      },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeFailure(`JEV_HTTP_${response.status}`);
  }
  const data = await readBoundedBody(response);
  const answer = data?.answers?.is_urgent;
  const usage = data?.usage;
  if (
    data?.model !== model ||
    answer?.type !== "noul" ||
    typeof answer.noul !== "number" ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1 ||
    !Number.isSafeInteger(usage?.input_tokens) ||
    usage.input_tokens < 0 ||
    !Number.isSafeInteger(usage?.output_tokens) ||
    usage.output_tokens < 0
  )
    throw new ProbeFailure("JEV_RESPONSE_INVALID");

  // Only validated, explicitly selected fields can reach stdout.
  console.log(
    JSON.stringify(
      {
        result: "ok",
        started_at_utc: startedAt,
        http_status: response.status,
        model: data.model,
        duration_ms: Math.round(performance.now() - start),
        answer: { type: "noul", noul: answer.noul },
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        },
        requests: 1,
        scope: "synthetic-connectivity-only",
      },
      null,
      2,
    ),
  );
}

// Raw exceptions, HTTP bodies and headers may carry secrets; never print them.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        result: "failed",
        reason:
          error instanceof ProbeFailure
            ? error.message
            : "JEV_CONNECTION_FAILED",
      }),
    );
    process.exitCode = 1;
  });
}
