import {
  compareWindowArtifacts,
  type WindowComparison,
} from "./storage/window-metrics.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabasePool } from "./database.js";
import { currentBudgetMs } from "./budgets.js";
import { readJevMetrics } from "./storage/jev-metrics.js";
import {
  readJevBenchmark,
  readJevResult,
} from "./storage/jev-benchmarkstore.js";
import {
  accountMetrics,
  compareMetrics,
  type EconomicComparison,
} from "./storage/metrics.js";
import { loadReplayDataset } from "./storage/replaystore.js";
import { loadReplayManifest, loadReplayPage } from "./storage/replaystore.js";
import {
  evaluationContext,
  validateEvaluationInput,
} from "./storage/evaluation.js";

import {
  consumerReadiness,
  readOperationalReadiness,
  type ConsumerObservation,
} from "./storage/operational-readiness.js";

const datasetId = /^btc-replay:[a-f0-9]{64}$/;
const windowId = /^btc-replay-window:[a-f0-9]{64}$/;
const accountId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
function params(request: FastifyRequest, allowed: string[]) {
  const q = request.query as Record<string, unknown>;
  if (
    Object.entries(q).some(
      ([k, v]) =>
        !allowed.includes(k) || typeof v !== "string" || v.length > 2048,
    )
  )
    throw new Error("EXPERIMENT_INVALID_QUERY");
  return q as Record<string, string>;
}
/** Immutable selected cuts only. GET never captures/pins or executes strategy/model. */
export function registerExperimentRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pick<DatabasePool, "readOnly">;
    authService: {
      session(token: string): Promise<{ status: string; username?: string }>;
    };
    clock: () => Date;
  },
) {
  const jevOwners = new WeakMap<FastifyRequest, string>();
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const token = /^Bearer (.+)$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    const session = token ? await deps.authService.session(token) : null;
    if (!session || session.status !== "ok")
      return reply.code(401).send({ reason_code: "AUTH_UNAUTHENTICATED" });
    if (request.routeOptions.url?.startsWith("/trading/jev/")) {
      if (!session.username || !accountId.test(session.username))
        return reply.code(401).send({ reason_code: "AUTH_UNAUTHENTICATED" });
      jevOwners.set(request, session.username);
    }
  }
  // CLI replay loads allow 5s; HTTP must stay inside the existing 4s API ceiling.
  const reportPool: Pick<DatabasePool, "readOnly"> = {
    readOnly: (_ms, run) => deps.pool.readOnly(currentBudgetMs() ?? 4000, run),
  };
  let reportBusy = false;
  function handler(run: (request: FastifyRequest) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const report =
        request.routeOptions.url === "/trading/experiments" ||
        request.routeOptions.url?.startsWith("/trading/jev/");
      if (report && reportBusy)
        return reply.code(503).send({ reason_code: "EXPERIMENT_READ_BUSY" });
      if (report) reportBusy = true;
      try {
        return await run(request);
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        const invalid =
          code === "EXPERIMENT_INVALID_QUERY" ||
          code === "EXPERIMENT_ACCOUNT_MISMATCH" ||
          /^BTC_METRICS_/.test(code);
        const missing =
          code === "BTC_REPLAY_DATASET_MISSING_OR_OVERSIZE" ||
          code === "JEV_ACCOUNT_NOT_FOUND" ||
          code === "JEV_RESULT_NOT_FOUND";
        return reply.code(invalid ? 400 : missing ? 404 : 503).send({
          reason_code:
            invalid || missing ? code : "EXPERIMENT_READ_UNAVAILABLE",
        });
      } finally {
        if (report) reportBusy = false;
      }
    };
  }
  app.get(
    "/trading/jev/metrics",
    { preHandler: guard },
    handler(async (request) => {
      const q = params(request, ["account_id", "origin"]);
      if (
        !q.account_id ||
        !accountId.test(q.account_id) ||
        (q.origin !== undefined && !["real", "mock"].includes(q.origin))
      )
        throw new Error("EXPERIMENT_INVALID_QUERY");
      return readJevMetrics(
        reportPool,
        jevOwners.get(request)!,
        q.account_id,
        q.origin === "mock" ? "mock" : "real",
      );
    }),
  );
  app.get(
    "/trading/jev/benchmarks",
    { preHandler: guard },
    handler(async (request) => {
      const q = params(request, ["account_id"]);
      if (!q.account_id || !accountId.test(q.account_id))
        throw new Error("EXPERIMENT_INVALID_QUERY");
      return readJevBenchmark(
        reportPool,
        jevOwners.get(request)!,
        q.account_id,
      );
    }),
  );
  app.get(
    "/trading/jev/results",
    { preHandler: guard },
    handler(async (request) => {
      const q = params(request, ["evidence_id"]);
      if (
        !q.evidence_id ||
        !/^jev-(metrics|benchmark):[A-Za-z0-9][A-Za-z0-9._:/-]{1,320}$/.test(
          q.evidence_id,
        )
      )
        throw new Error("EXPERIMENT_INVALID_QUERY");
      return readJevResult(reportPool, jevOwners.get(request)!, q.evidence_id);
    }),
  );
  app.get(
    "/trading/experiment-datasets",
    { preHandler: guard },
    handler(async (request) => {
      const q = params(request, ["after", "kind"]);
      if (
        (q.kind && q.kind !== "window") ||
        (q.after && !(q.kind === "window" ? windowId : datasetId).test(q.after))
      )
        throw new Error("EXPERIMENT_INVALID_QUERY");
      return deps.pool.readOnly(currentBudgetMs() ?? 1500, async (tx) => {
        // B-tree range on immutable object ID; no raw/payload scan or automatic capture.
        const rows = (
          await tx.query<{
            dataset_id: string;
            account_id: string;
            captured_at: Date;
          }>(
            `SELECT object_id AS dataset_id, identity->>'account_id' AS account_id, recorded_at AS captured_at
         FROM btc_retention_objects WHERE object_id > $1 AND object_id >= $2 AND object_id <= $3
           AND object_id LIKE $4
         ORDER BY object_id LIMIT 51`,
            [
              q.after ?? "",
              `${q.kind === "window" ? "btc-replay-window" : "btc-replay"}:${"0".repeat(64)}`,
              `${q.kind === "window" ? "btc-replay-window" : "btc-replay"}:${"f".repeat(64)}`,
              `${q.kind === "window" ? "btc-replay-window" : "btc-replay"}:%`,
            ],
          )
        ).rows;
        return {
          items: rows.slice(0, 50),
          next_cursor: rows.length > 50 ? rows[49]!.dataset_id : null,
        };
      });
    }),
  );
  const reportHandler = handler(async (request) => {
    const q = params(request, [
      "account_id",
      "dataset_id",
      "challenger_id",
      "comparison",
      "page",
    ]);
    let input;
    if (request.method === "POST")
      input = validateEvaluationInput(request.body);
    if (
      !q.account_id ||
      !accountId.test(q.account_id) ||
      !q.dataset_id ||
      !(datasetId.test(q.dataset_id) || windowId.test(q.dataset_id)) ||
      (q.challenger_id !== undefined && !datasetId.test(q.challenger_id)) ||
      (q.comparison && !q.challenger_id)
    )
      throw new Error("EXPERIMENT_INVALID_QUERY");
    if (windowId.test(q.dataset_id)) {
      if (
        input ||
        q.challenger_id ||
        q.comparison ||
        (q.page !== undefined && !/^(0|[1-9][0-9]{0,3})$/.test(q.page))
      )
        throw new Error("EXPERIMENT_INVALID_QUERY");
      const m = await loadReplayManifest(reportPool, q.dataset_id);
      if (m.manifest.header.identity.account.account_id !== q.account_id)
        throw new Error("EXPERIMENT_ACCOUNT_MISMATCH");
      if (q.page !== undefined && Number(q.page) >= m.manifest.pages.length)
        throw new Error("EXPERIMENT_INVALID_QUERY");
      const page =
        q.page === undefined
          ? null
          : await loadReplayPage(reportPool, q.dataset_id, Number(q.page));
      return {
        schema_version: "btc.paged-coverage.v1",
        mode: "paper",
        dataset_id: m.dataset_id,
        window: m.manifest.header.window,
        captured_at: m.manifest.header.cut.captured_at,
        counts: m.manifest.counts,
        pages: m.manifest.pages.length,
        bytes: m.manifest.bytes,
        verified_page: page
          ? { index: page.index, stream: page.stream, rows: page.rows.length }
          : null,
        status: "manifest_verified_full_replay_required",
        financial_metrics: null,
      };
    }
    if (q.page !== undefined) throw new Error("EXPERIMENT_INVALID_QUERY");
    let contract: EconomicComparison | WindowComparison | undefined;
    if (q.comparison) {
      try {
        const c: unknown = JSON.parse(q.comparison);
        if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error();
        const value = c as EconomicComparison;
        if (!Array.isArray(value.declared_version_differences))
          throw new Error();
        contract = value;
      } catch {
        throw new Error("EXPERIMENT_INVALID_QUERY");
      }
    }
    const artifact = await loadReplayDataset(reportPool, q.dataset_id);
    if (artifact.dataset.identity.account.account_id !== q.account_id)
      throw new Error("EXPERIMENT_ACCOUNT_MISMATCH");
    const challengerArtifact = q.challenger_id
      ? await loadReplayDataset(reportPool, q.challenger_id)
      : null;
    let comparison;
    try {
      comparison =
        contract?.schema_version === "btc.economic-comparison.v2" &&
        challengerArtifact
          ? compareWindowArtifacts(
              artifact,
              challengerArtifact,
              contract,
              input?.allocation,
            )
          : compareMetrics(
              accountMetrics(artifact, input?.allocation),
              challengerArtifact
                ? accountMetrics(challengerArtifact, input?.allocation)
                : null,
              contract as EconomicComparison | undefined,
            );
    } catch (e) {
      const reason = e instanceof Error ? e.message : "";
      if (!/^BTC_METRICS_COMPARISON_[A-Z_]+$/.test(reason)) throw e;
      comparison = {
        status: "not_comparable",
        reason,
        baseline: accountMetrics(artifact, input?.allocation),
        challenger: challengerArtifact
          ? accountMetrics(challengerArtifact, input?.allocation)
          : null,
        delta: null,
      };
    }
    return {
      mode: "paper",
      ...comparison,
      evaluation: evaluationContext(
        input,
        comparison.baseline.scope,
        "opening" in comparison.baseline
          ? comparison.baseline.opening.equity_usd_raw
          : comparison.baseline.capital_usd_raw,
      ),
      schema_version:
        contract?.schema_version === "btc.economic-comparison.v2"
          ? "btc.experiments.v2"
          : "btc.experiments.v1",
    };
  });
  app.get("/trading/experiments", { preHandler: guard }, reportHandler);
  // A private body keeps billing inputs out of URLs/access logs. Same read-only pool.
  app.post(
    "/trading/experiments",
    { preHandler: guard, bodyLimit: 32768 },
    reportHandler,
  );
  app.get(
    "/trading/experiment-system",
    { preHandler: guard },
    handler(async (request) => {
      const q = params(request, ["after"]);
      if (q.after && !accountId.test(q.after))
        throw new Error("EXPERIMENT_INVALID_QUERY");
      return deps.pool.readOnly(currentBudgetMs() ?? 1500, async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const capacity =
          (
            await tx.query(`SELECT hold,raw_bytes::text,total_bytes::text,
        raw_quota_bytes::text,total_quota_bytes::text,
        (pg_total_relation_size('btc_retention_objects') + pg_total_relation_size('btc_retention_dependencies')
        + pg_total_relation_size('btc_retention_pins') + pg_total_relation_size('btc_market_records')
        + pg_total_relation_size('btc_market_bars') + pg_total_relation_size('btc_market_head'))::text AS physical_bytes
        FROM btc_retention_policy WHERE dataset_id='btc-paper-v1'`)
          ).rows[0] ?? null;
        const head = (
          await tx.query<{ last_capture_at: Date }>(
            "SELECT last_capture_at FROM btc_market_head WHERE singleton=true",
          )
        ).rows[0];
        const recovery = (
          await tx.query<
            ConsumerObservation & {
              account_id: string;
              generation: string | null;
              reason: string | null;
              lease_alive: boolean;
              checkpoint_at: Date | null;
            }
          >(
            `SELECT a.account_id,h.generation::text,h.status,h.reason,h.lease_until,
        d.enabled,r.ready AS consumer_ready,r.observed_at AS consumer_at,r.reason AS consumer_reason,
        h.lease_until > clock_timestamp() AS lease_alive, CASE WHEN c.generation=h.generation THEN c.recorded_at ELSE NULL END AS checkpoint_at
        FROM btc_ledger_accounts a LEFT JOIN btc_recovery_heads h USING(account_id)
        LEFT JOIN btc_desk_controls d USING(account_id) LEFT JOIN btc_desk_runtime r USING(account_id) LEFT JOIN LATERAL
        (SELECT recorded_at,generation FROM btc_recovery_checkpoints WHERE account_id=h.account_id
         ORDER BY sequence DESC LIMIT 1) c ON true
        WHERE a.account_id > $1 ORDER BY a.account_id LIMIT 21`,
            [q.after ?? ""],
          )
        ).rows;
        const now = deps.clock();
        const operational = await readOperationalReadiness(tx, now);
        const accounts = recovery.slice(0, 20).map((row) => ({
          ...row,
          readiness: consumerReadiness(row, now.getTime()),
        }));
        const age = head
          ? now.getTime() - new Date(head.last_capture_at).getTime()
          : null;
        return {
          as_of: now.toISOString(),
          operational: {
            ...operational,
            account_scope: "current_page",
            accounts_ready:
              accounts.length > 0 &&
              accounts.every((a) => a.readiness.status === "ready"),
            risk_authorization: false,
          },
          capacity,
          worker_limits: {
            raw_bytes: "4294967296",
            total_bytes: "6442450944",
            physical_bytes: "4294967296",
          },
          host_disk: null,
          container_restarts: null,
          container_status: "unavailable",
          feed: {
            last_capture_at: head?.last_capture_at ?? null,
            age_ms: age,
            status:
              age === null || age < 0
                ? "unknown"
                : age > 60000
                  ? "stale"
                  : "recent_capture",
            continuity: "unproven",
            stale_after_ms: 60000,
          },
          recovery: accounts,
          next_cursor: recovery.length > 20 ? recovery[19]!.account_id : null,
        };
      });
    }),
  );
}
