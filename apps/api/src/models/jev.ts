import { performance } from "node:perf_hooks";
import type { JevStore, JevReservation } from "../storage/jevstore.js";
import {
  JevWireResponse,
  JEV_VERSION,
  JEV_PROMPT_HASH,
  JEV_PROMPT_VERSION,
  jevHash,
  iso,
  quote,
  validInput,
  usageCost,
  validateAnswer,
  type JevRequest,
  type JevResult,
  type JevReason,
  type JevTariff,
  type JevTransport,
} from "./jev-contract.js";
export type {
  JevRequest,
  JevResult,
  JevTransport,
  JevTariff,
} from "./jev-contract.js";

/** Disabled unless explicitly composed with enabled=true AND a separately
 * provisioned persistent budget. This module has no trading/executor import.
 * One durable attempt per request ID; retries are deliberately fixed at zero. */
export function createJevAdapter(options: {
  store: JevStore;
  transport: JevTransport;
  enabled?: boolean | undefined;
  tariff?: JevTariff | undefined;
}) {
  const { store, transport, enabled = false } = options;
  const tariff = options.tariff
    ? Object.freeze({ ...options.tariff })
    : undefined;
  return {
    identity: Object.freeze({
      origin: transport.origin,
      model: transport.model,
    }),
    async evaluate(
      request: JevRequest,
      cancellation?: AbortSignal,
    ): Promise<JevResult> {
      const started = performance.now();
      const base: JevResult = {
        input: null,
        original_response: null,
        response_hash: null,
        response_received_at: null,
        version: JEV_VERSION,
        prompt_version: JEV_PROMPT_VERSION,
        prompt_hash: JEV_PROMPT_HASH,
        request_id: request.request_id,
        input_hash: "",
        model: transport.model,
        origin: transport.origin,
        decision: "abstain",
        reason: "disabled",
        attempted: false,
        started_at: new Date().toISOString(),
        deadline_at: request.deadline_at,
        duration_ms: 0,
        reserved_usd6: "0",
        cost_usd6: "0",
        tariff_version: tariff?.version ?? null,
        tariff: tariff ?? null,
        usage: null,
        answer: null,
      };
      const refuse = (reason: JevReason): JevResult => ({
        ...base,
        reason,
        duration_ms: Math.max(0, performance.now() - started),
      });
      if (!enabled) return refuse("disabled");
      if (
        !/^[a-zA-Z0-9:._-]{1,200}$/.test(request.request_id) ||
        !validInput(request.input) ||
        !iso(request.deadline_at)
      )
        return refuse("invalid_input");
      // Snapshot before any await: caller mutation must never diverge from the hash.
      const input = Object.freeze({ ...request.input }),
        deadline = Date.parse(request.deadline_at);
      base.input = input;
      base.input_hash = jevHash(input);
      if (cancellation?.aborted) return refuse("cancelled");
      const remaining = deadline - Date.now();
      if (remaining <= 0 || remaining > 30_000) return refuse("timeout");
      const reserved = quote(tariff, transport.model, request.deadline_at);
      if (!reserved || !tariff) return refuse("cost_unknown");
      base.reserved_usd6 = reserved;
      base.cost_usd6 = null;
      const fingerprint = jevHash({
        input,
        model: transport.model,
        prompt: JEV_PROMPT_HASH,
        deadline: request.deadline_at,
        tariff,
      });
      let reservation: JevReservation;
      try {
        const result = await store.reserve(base, fingerprint, jevHash(tariff));
        if (typeof result === "string")
          return { ...refuse(result), reserved_usd6: "0", cost_usd6: "0" };
        reservation = result;
      } catch {
        // COMMIT acknowledgement can be lost. Do not assume the hold rolled back.
        return refuse("storage_error");
      }
      let result: JevResult = { ...reservation.result },
        billingUnknown = false;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onCancel: (() => void) | undefined;
      try {
        const window = Math.min(
          deadline - Date.now(),
          remaining - (performance.now() - started),
        );
        if (cancellation?.aborted || window <= 0) {
          result.reason = cancellation?.aborted ? "cancelled" : "timeout";
          // Nothing dispatched, therefore known zero cost (unless finalization
          // itself misses the deadline, where the store stays conservative).
          result.attempted = false;
          result.cost_usd6 = "0";
        } else {
          type Completion =
            | { raw: unknown }
            | { failure: "timeout" | "cancelled" | "provider_error" };
          const stopped = new Promise<Completion>((resolve) => {
            onCancel = () => {
              resolve({ failure: "cancelled" });
              controller.abort();
            };
            cancellation?.addEventListener("abort", onCancel, { once: true });
            timer = setTimeout(() => {
              resolve({ failure: "timeout" });
              controller.abort();
            }, window);
          });
          // Promise handlers absorb late resolution/rejection. No late callback
          // writes storage, frees a charge, or changes the returned decision.
          const response = Promise.resolve()
            .then(() => {
              if (controller.signal.aborted) throw new Error("JEV_CANCELLED");
              return transport.evaluate(input, controller.signal);
            })
            .then<Completion, Completion>(
              (raw) => ({ raw }),
              () => ({ failure: "provider_error" }),
            );
          const completed = await Promise.race([stopped, response]);
          if ("failure" in completed) result.reason = completed.failure;
          else if (cancellation?.aborted) result.reason = "cancelled";
          else if (
            Date.now() >= deadline ||
            performance.now() - started >= remaining
          )
            result.reason = "timeout";
          else {
            const original =
              completed.raw instanceof JevWireResponse
                ? completed.raw.body
                : JSON.stringify(completed.raw);
            if (
              typeof original !== "string" ||
              Buffer.byteLength(original) > 16_384
            )
              throw new Error("JEV_RESPONSE_REJECTED");
            result.original_response = original;
            result.response_hash = jevHash(original);
            result.response_received_at = new Date().toISOString();
            let raw: unknown = null;
            try {
              raw = JSON.parse(original) as unknown;
            } catch {
              /* Retain malformed original, fail closed. */
            }
            const billed = usageCost(raw, tariff);
            const answer = validateAnswer(raw, transport.model);
            if (!billed) {
              result.reason = "cost_unknown";
              billingUnknown = true;
            } else {
              result.cost_usd6 = billed.cost;
              result.usage = billed.usage;
              result.reason = answer ? "ok" : "malformed_response";
              result.answer = answer;
              result.decision = answer?.decision ?? "abstain";
            }
          }
        }
      } catch {
        result.reason = "provider_error";
      } finally {
        clearTimeout(timer);
        if (onCancel) cancellation?.removeEventListener("abort", onCancel);
        controller.abort();
      }
      result.duration_ms = Math.max(0, performance.now() - started);
      try {
        const settled = await store.finish(reservation, result, billingUnknown);
        // A completed judgment can expire while waiting for COMMIT/return.
        return Date.now() >= deadline || cancellation?.aborted
          ? {
              ...settled,
              decision: "abstain",
              answer: null,
              reason: cancellation?.aborted ? "cancelled" : "timeout",
            }
          : settled;
      } catch {
        return {
          ...result,
          decision: "abstain",
          answer: null,
          reason: "storage_error",
          cost_usd6: null,
        };
      }
    },
  };
}
