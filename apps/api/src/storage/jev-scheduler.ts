import type {
  JevBatch,
  JevBatchResult,
} from "../models/jev-decision-contract.js";
export const JEV_SCHEDULER_VERSION = "jev.scheduler.v1";
export interface PreparedCycle {
  batch: JevBatch;
  tokens: Record<string, string>;
}
export interface SchedulerMetrics {
  risk_cycles: number;
  decision_cycles: number;
  decision_failures: number;
  busy_skips: number;
  last_risk_at: number;
  last_risk_ms: number;
  last_decision_ms: number;
  last_cycle_ms: number;
}
/** A bounded lane per profile and a separate protection clock. No queued ticks,
 * sleep after inference, retry or fallback. The provider's deadline cancels only
 * inference; risk/reconciliation continues while HTTP is pending. */
export function createJevScheduler<A>(options: {
  now?: () => number;
  accounts: () => Promise<A[]>;
  profile: (a: A) => string;
  accountKey: (a: A) => string;
  protect: (a: A, recover: boolean) => Promise<void>;
  prepare: (accounts: A[], now: number) => Promise<PreparedCycle | null>;
  evaluate: (batch: JevBatch, signal: AbortSignal) => Promise<JevBatchResult>;
  complete: (
    result: JevBatchResult,
    tokens: Record<string, string>,
  ) => Promise<void>;
  failed: (cycle: PreparedCycle, error: unknown) => Promise<void>;
}) {
  const now = options.now ?? Date.now,
    lanes = new Map<
      string,
      { controller: AbortController; task: Promise<void> }
    >(),
    recovered = new Set<string>();
  const metrics: SchedulerMetrics = {
    risk_cycles: 0,
    decision_cycles: 0,
    decision_failures: 0,
    busy_skips: 0,
    last_risk_at: 0,
    last_risk_ms: 0,
    last_decision_ms: 0,
    last_cycle_ms: 0,
  };
  let stopped = false,
    lastRisk = -Infinity,
    persistenceError: unknown = null,
    running: Promise<void> | null = null;
  const cycle = async () => {
    const started = now(),
      accounts = await options.accounts();
    // Protection and takeover reconciliation always precede decisions.
    if (started - lastRisk >= 1000) {
      for (const a of accounts) {
        const key = options.accountKey(a);
        await options.protect(a, !recovered.has(key));
      }
      for (const a of accounts) recovered.add(options.accountKey(a));
      lastRisk = started;
      metrics.risk_cycles++;
      metrics.last_risk_at = now();
      metrics.last_risk_ms = now() - started;
    }
    const groups = new Map<string, A[]>();
    for (const a of accounts) {
      const key = options.profile(a);
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    // JE07 integrates a single profile. Multi-profile dispatch belongs to JE10.
    for (const [key, group] of [...groups].slice(0, 1)) {
      if (lanes.has(key)) {
        metrics.busy_skips++;
        continue;
      }
      const prepared = await options.prepare(group, now());
      if (!prepared) continue;
      const controller = new AbortController(),
        began = now();
      const lane = { controller, task: Promise.resolve() };
      lanes.set(key, lane);
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(0, Date.parse(prepared.batch.deadline_at) - now()),
      );
      metrics.decision_cycles++;
      lane.task = Promise.resolve()
        .then(() => options.evaluate(prepared.batch, controller.signal))
        .then(async (result) => {
          // Never act on a cancelled/late response. Costs/originals stay in JE04's
          // independent durable journal, including rejection during worker shutdown.
          if (
            stopped ||
            controller.signal.aborted ||
            now() > Date.parse(prepared.batch.deadline_at)
          ) {
            await options.failed(prepared, new Error("JEV_RESPONSE_STALE"));
            return;
          }
          await options.complete(result, prepared.tokens);
        })
        .catch(async (error) => {
          metrics.decision_failures++;
          await options.failed(prepared, error);
        })
        .finally(() => {
          clearTimeout(timer);
          metrics.last_decision_ms = now() - began;
          lanes.delete(key);
        });
      // A failed durable finalization stops the next tick and its health
      // publication. Takeover recovers the pending marker without resending it.
      lane.task = lane.task.catch((error) => {
        metrics.decision_failures++;
        persistenceError = error;
      });
    }
    metrics.last_cycle_ms = now() - started;
  };
  return {
    metrics,
    async tick() {
      if (persistenceError) throw persistenceError;
      if (stopped || running) return;
      running = cycle();
      try {
        await running;
      } finally {
        running = null;
      }
    },
    async stop() {
      stopped = true;
      for (const lane of lanes.values()) lane.controller.abort();
      await running;
      await Promise.all([...lanes.values()].map((l) => l.task));
    },
    active: () => lanes.size,
  };
}
