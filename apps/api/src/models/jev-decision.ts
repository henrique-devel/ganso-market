import { performance } from "node:perf_hooks";
import { quote, type JevTariff } from "./jev-contract.js";
import {
  JEV_DECISION_VERSION,
  JEV_LIMITS,
  validateJevBatch,
  refusedDecisions,
  type JevBatch,
  type JevBatchResult,
  type JevFailure,
} from "./jev-decision-contract.js";
import { deriveJevResult } from "./jev-decision-replay.js";
import {
  JevTransportFailure,
  type JevBatchTransport,
} from "./jev-decision-typesafe.js";
import { jevHash } from "../storage/jev-hash.js";
import type { JevDecisionStore } from "../storage/jev-decision-store.js";
/** Dormant composable backend. No scheduler, baseline, signer, order or risk dependency. */
export function createJevDecisionAdapter(options: {
  store: JevDecisionStore;
  transport: JevBatchTransport;
  enabled?: boolean;
  tariff?: JevTariff;
}) {
  const tariff = options.tariff ? structuredClone(options.tariff) : null;
  let active = 0;
  return {
    async evaluate(
      input: JevBatch,
      cancellation?: AbortSignal,
    ): Promise<JevBatchResult> {
      const batch = structuredClone(input),
        started = performance.now(),
        now = new Date().toISOString();
      const base: JevBatchResult = {
        schema_version: JEV_DECISION_VERSION,
        origin: options.transport.origin,
        batch,
        batch_hash: jevHash(batch),
        reason: "invalid_input",
        attempted: false,
        started_at: now,
        finished_at: now,
        response_received_at: null,
        http_status: null,
        original_response: null,
        response_hash: null,
        tariff,
        reserved_usd6: "0",
        cost_usd6: "0",
        usage: null,
        decisions: [],
      };
      const fail = (reason: JevFailure, r = base): JevBatchResult => ({
        ...r,
        reason,
        decisions: refusedDecisions(batch, reason, r.cost_usd6),
      });
      try {
        validateJevBatch(batch);
      } catch {
        return fail("invalid_input");
      }
      let refusal: JevFailure | undefined;
      if (!options.enabled) refusal = "disabled";
      else if (batch.model !== options.transport.model)
        refusal = "binding_error";
      else if (cancellation?.aborted) refusal = "cancelled";
      else if (active >= JEV_LIMITS.concurrent_requests)
        refusal = "concurrency_limit";
      else if (!tariff || !quote(tariff, batch.model, batch.deadline_at))
        refusal = "cost_unknown";
      if (!refusal && tariff)
        base.reserved_usd6 = quote(tariff, batch.model, batch.deadline_at)!;
      active++;
      try {
        let reservation;
        try {
          reservation = await options.store.reserve(
            batch,
            options.transport.origin,
            tariff,
            refusal,
          );
        } catch {
          return fail("storage_error", { ...base, cost_usd6: null });
        }
        if (!("token" in reservation)) return reservation;
        let result = structuredClone(reservation.result);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined,
          onCancel: (() => void) | undefined;
        const remaining = Math.min(
          Date.parse(batch.deadline_at) - Date.now(),
          Date.parse(batch.deadline_at) -
            Date.parse(now) -
            (performance.now() - started),
        );
        try {
          if (remaining <= 0 || cancellation?.aborted) {
            result.reason = cancellation?.aborted ? "cancelled" : "timeout";
            result.attempted = false;
            result.cost_usd6 = "0";
          } else {
            type Completion =
              | { wire: Awaited<ReturnType<JevBatchTransport["evaluate"]>> }
              | { failure: JevFailure };
            const stopped = new Promise<Completion>((resolve) => {
              onCancel = () => {
                resolve({ failure: "cancelled" });
                controller.abort();
              };
              cancellation?.addEventListener("abort", onCancel, { once: true });
              timer = setTimeout(() => {
                resolve({ failure: "timeout" });
                controller.abort();
              }, remaining);
            });
            // Late fulfillment/rejection is absorbed and never finalizes again.
            const response = Promise.resolve()
              .then(() => {
                if (controller.signal.aborted)
                  throw new JevTransportFailure("cancelled");
                return options.transport.evaluate(batch, controller.signal);
              })
              .then<Completion, Completion>(
                (wire) => ({ wire }),
                (e) => ({
                  failure:
                    e instanceof JevTransportFailure
                      ? e.reason
                      : "provider_error",
                }),
              );
            const completed = await Promise.race([stopped, response]);
            if ("failure" in completed) result.reason = completed.failure;
            else {
              const w = completed.wire;
              if (Buffer.byteLength(w.body) > JEV_LIMITS.response_bytes)
                result.reason = "oversized_response";
              else {
                result.original_response = w.body;
                result.response_received_at = w.received_at;
                result.http_status = w.status;
                result.reason = cancellation?.aborted
                  ? "cancelled"
                  : w.status === 429
                    ? "rate_limited"
                    : w.status === 200
                      ? "ok"
                      : "provider_error";
                if (
                  Date.now() >= Date.parse(batch.deadline_at) ||
                  performance.now() - started >=
                    Date.parse(batch.deadline_at) - Date.parse(now)
                )
                  result.reason = "timeout";
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
        result.finished_at = new Date().toISOString();
        result = deriveJevResult(result);
        try {
          const settled = await options.store.finish(reservation, result);
          return cancellation?.aborted
            ? fail("cancelled", settled)
            : Date.now() >= Date.parse(batch.deadline_at)
              ? fail("timeout", settled)
              : settled;
        } catch {
          return fail("storage_error", { ...result, cost_usd6: null });
        }
      } finally {
        active--;
      }
    },
  };
}
