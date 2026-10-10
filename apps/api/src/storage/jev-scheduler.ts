import type {
  JevBatch,
  JevBatchResult,
} from "../models/jev-decision-contract.js";
export const JEV_SCHEDULER_VERSION = "jev.scheduler.v3";
export const JEV_DISPATCH_LIMITS = Object.freeze({
  profiles: 3,
  accounts: 7,
  accounts_per_profile: 3,
  protection_concurrency: 3,
  protection_interval_ms: 1000,
});
export interface PreparedCycle {
  batch: JevBatch;
  tokens: Record<string, string>;
}
export interface SchedulerMetrics {
  risk_cycles: number;
  protection_failures: number;
  preparation_failures: number;
  accounts: number;
  profiles: number;
  active_lanes: number;
  max_active_lanes: number;
  protected_accounts: number;
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
  unavailable?: (accounts: A[], error: unknown) => Promise<void>;
}) {
  const now = options.now ?? Date.now,
    lanes = new Map<
      string,
      { controller: AbortController; task: Promise<void> }
    >(),
    recovered = new Set<string>(),
    blocked = new Set<string>();
  const metrics: SchedulerMetrics = {
    risk_cycles: 0,
    protection_failures: 0,
    preparation_failures: 0,
    accounts: 0,
    profiles: 0,
    active_lanes: 0,
    max_active_lanes: 0,
    protected_accounts: 0,
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
  const unavailable = async (accounts: A[], error: unknown) => {
    if (
      !options.unavailable ||
      (error instanceof Error && error.message === "EXECUTION_WORKER_FENCED")
    )
      throw error;
    await options.unavailable(accounts, error);
  };
  const cycle = async () => {
    const started = now(),
      accounts = await options.accounts();
    const keys = accounts.map(options.accountKey),
      groups = new Map<string, A[]>();
    for (const a of accounts) {
      const key = options.profile(a);
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    if (
      accounts.length > JEV_DISPATCH_LIMITS.accounts ||
      new Set(keys).size !== keys.length ||
      groups.size > JEV_DISPATCH_LIMITS.profiles ||
      [...groups.values()].some(
        (g) => g.length > JEV_DISPATCH_LIMITS.accounts_per_profile,
      )
    )
      throw new Error("JEV_DISPATCH_REGISTRY");
    metrics.accounts = accounts.length;
    metrics.profiles = groups.size;
    // Separate bounded protection lanes: an account-local fault or a slow SQL
    // read cannot prevent another account's reduction from being attempted.
    if (started - lastRisk >= JEV_DISPATCH_LIMITS.protection_interval_ms) {
      let index = 0;
      let fatal: unknown = null;
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              accounts.length,
              JEV_DISPATCH_LIMITS.protection_concurrency,
            ),
          },
          async () => {
            while (index < accounts.length) {
              const a = accounts[index++]!,
                key = options.accountKey(a);
              try {
                await options.protect(a, !recovered.has(key));
                recovered.add(key);
                blocked.delete(key);
              } catch (error) {
                blocked.add(key);
                metrics.protection_failures++;
                try {
                  await unavailable([a], error);
                } catch (failure) {
                  fatal ??= failure;
                }
              }
            }
          },
        ),
      );
      lastRisk = started;
      metrics.risk_cycles++;
      metrics.protected_accounts = accounts.filter(
        (a) => !blocked.has(options.accountKey(a)),
      ).length;
      metrics.last_risk_at = now();
      metrics.last_risk_ms = now() - started;
      if (fatal) throw fatal;
    }
    if (stopped) return;
    for (const [key, group] of groups) {
      if (lanes.has(key) || lanes.size >= JEV_DISPATCH_LIMITS.profiles) {
        metrics.busy_skips++;
        continue;
      }
      const ready = group.filter(
        (a) =>
          recovered.has(options.accountKey(a)) &&
          !blocked.has(options.accountKey(a)),
      );
      if (!ready.length) continue;
      const controller = new AbortController(),
        began = now();
      const lane = { controller, task: Promise.resolve() };
      lanes.set(key, lane);
      metrics.active_lanes = lanes.size;
      metrics.max_active_lanes = Math.max(metrics.max_active_lanes, lanes.size);
      // Preparation also owns its profile lane. No accumulated ticks and no
      // serial await that lets one profile's context block the protection clock.
      lane.task = Promise.resolve()
        .then(async () => {
          let prepared: PreparedCycle | null;
          try {
            prepared = await options.prepare(ready, now());
          } catch (error) {
            metrics.preparation_failures++;
            await unavailable(ready, error);
            return;
          }
          if (!prepared) return;
          const timer = setTimeout(
            () => controller.abort(),
            Math.max(0, Date.parse(prepared.batch.deadline_at) - now()),
          );
          try {
            if (
              stopped ||
              controller.signal.aborted ||
              now() > Date.parse(prepared.batch.deadline_at)
            ) {
              await options.failed(prepared, new Error("JEV_RESPONSE_STALE"));
              return;
            }
            metrics.decision_cycles++;
            const result = await options.evaluate(
              prepared.batch,
              controller.signal,
            );
            if (
              stopped ||
              controller.signal.aborted ||
              now() > Date.parse(prepared.batch.deadline_at)
            ) {
              await options.failed(prepared, new Error("JEV_RESPONSE_STALE"));
              return;
            }
            await options.complete(result, prepared.tokens);
          } catch (error) {
            metrics.decision_failures++;
            await options.failed(prepared, error);
          } finally {
            clearTimeout(timer);
          }
        })
        .catch((error) => {
          metrics.decision_failures++;
          persistenceError = error;
        })
        .finally(() => {
          metrics.last_decision_ms = now() - began;
          lanes.delete(key);
          metrics.active_lanes = lanes.size;
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
