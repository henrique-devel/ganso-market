import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabasePool } from "./database.js";
import { currentBudgetMs } from "./budgets.js";
import {
  accountMetrics,
  compareMetrics,
  type EconomicComparison,
} from "./storage/metrics.js";
import { loadReplayDataset } from "./storage/replaystore.js";

const datasetId = /^btc-replay:[a-f0-9]{64}$/;
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
    authService: { session(token: string): Promise<{ status: string }> };
    clock: () => Date;
  },
) {
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const token = /^Bearer (.+)$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token || (await deps.authService.session(token)).status !== "ok")
      return reply.code(401).send({ reason_code: "AUTH_UNAUTHENTICATED" });
  }
  let reportBusy = false;
  function handler(run: (request: FastifyRequest) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const report = request.routeOptions.url === "/trading/experiments";
      if (report && reportBusy)
        return reply.code(503).send({ reason_code: "EXPERIMENT_READ_BUSY" });
      if (report) reportBusy = true;
      try {
        return await run(request);
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        const invalid =
          code === "EXPERIMENT_INVALID_QUERY" ||
          code === "EXPERIMENT_ACCOUNT_MISMATCH";
        const missing = code === "BTC_REPLAY_DATASET_MISSING_OR_OVERSIZE";
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
    "/trading/experiment-datasets",
    { preHandler: guard },
    handler(async (request) => {
      const q = params(request, ["after"]);
      if (q.after && !datasetId.test(q.after))
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
           AND object_id LIKE 'btc-replay:%'
         ORDER BY object_id LIMIT 51`,
            [
              q.after ?? "",
              `btc-replay:${"0".repeat(64)}`,
              `btc-replay:${"f".repeat(64)}`,
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
  app.get(
    "/trading/experiments",
    { preHandler: guard },
    handler(async (request) => {
      const q = params(request, [
        "account_id",
        "dataset_id",
        "challenger_id",
        "comparison",
      ]);
      if (
        !q.account_id ||
        !accountId.test(q.account_id) ||
        !q.dataset_id ||
        !datasetId.test(q.dataset_id) ||
        (q.challenger_id !== undefined && !datasetId.test(q.challenger_id)) ||
        (q.comparison && !q.challenger_id)
      )
        throw new Error("EXPERIMENT_INVALID_QUERY");
      let contract: EconomicComparison | undefined;
      if (q.comparison) {
        try {
          const c: unknown = JSON.parse(q.comparison);
          if (!c || typeof c !== "object" || Array.isArray(c))
            throw new Error();
          const value = c as EconomicComparison;
          if (!Array.isArray(value.declared_version_differences))
            throw new Error();
          contract = value;
        } catch {
          throw new Error("EXPERIMENT_INVALID_QUERY");
        }
      }
      const artifact = await loadReplayDataset(deps.pool, q.dataset_id);
      if (artifact.dataset.identity.account.account_id !== q.account_id)
        throw new Error("EXPERIMENT_ACCOUNT_MISMATCH");
      const baseline = accountMetrics(artifact);
      const challenger = q.challenger_id
        ? accountMetrics(await loadReplayDataset(deps.pool, q.challenger_id))
        : null;
      let comparison;
      try {
        comparison = compareMetrics(baseline, challenger, contract);
      } catch (e) {
        const reason = e instanceof Error ? e.message : "";
        if (!/^BTC_METRICS_COMPARISON_[A-Z_]+$/.test(reason)) throw e;
        comparison = {
          status: "not_comparable",
          reason,
          baseline,
          challenger,
          delta: null,
        };
      }
      return {
        schema_version: "btc.experiments.v1",
        mode: "paper",
        ...comparison,
      };
    }),
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
          await tx.query(
            `SELECT h.account_id,h.generation::text,h.status,h.reason,h.lease_until,
        h.lease_until > clock_timestamp() AS lease_alive, CASE WHEN c.generation=h.generation THEN c.recorded_at ELSE NULL END AS checkpoint_at
        FROM btc_recovery_heads h LEFT JOIN LATERAL
        (SELECT recorded_at,generation FROM btc_recovery_checkpoints WHERE account_id=h.account_id
         ORDER BY sequence DESC LIMIT 1) c ON true
        WHERE h.account_id > $1 ORDER BY h.account_id LIMIT 21`,
            [q.after ?? ""],
          )
        ).rows;
        const now = deps.clock();
        const age = head
          ? now.getTime() - new Date(head.last_capture_at).getTime()
          : null;
        return {
          as_of: now.toISOString(),
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
          recovery: recovery.slice(0, 20),
          next_cursor: recovery.length > 20 ? recovery[19]!.account_id : null,
        };
      });
    }),
  );
}
