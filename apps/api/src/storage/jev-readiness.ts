import type { DatabasePool, SqlExecutor } from "../database.js";
import type { JevScope } from "@ganso-market/contracts/trading";
import { jevScope } from "./jev-ledger.js";
import { loadJevAccountTx } from "./jev-store.js";
import { jevHash } from "./jev-hash.js";
import { readSourceReadinessTx } from "./operational-readiness.js";
import {
  jevDispatchRegistryHashTx,
  readJevDispatchCapacityTx,
} from "./jev-dispatch-capacity.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { makeJevEvidence, storeJevEvidenceTx } from "./jev-evidence.js";
import { jevDurationCoverage, type CoverageCapture } from "./jev-evaluation.js";
import { JEV_SCHEDULER_VERSION } from "./jev-scheduler.js";
import type { ExecutionLease } from "./execution-worker-lease.js";
export const JEV_ENGINE_POLICY = {
  version: "jev.engine-readiness.v1",
  sample_max_gap_ms: 1500,
  qualification_ms: 7 * 86400000,
};
export function engineFingerprint(sha: string) {
  return jevHash([sha, JEV_SCHEDULER_VERSION, JEV_ENGINE_POLICY.version]);
}
export type EnginePulse = {
  at: number;
  ready: boolean;
  reasons: string[];
  scope: JevScope;
  generation: string;
  ledger: Record<string, string>;
  flat: boolean;
  exercised: {
    execution: boolean;
    costs: boolean;
    funding: boolean;
    risk: boolean;
    recovery: boolean;
  };
};
/** Integrates every actual worker sample; a missing internal heartbeat is not covered by minute edges. */
export function engineTimeline(
  pulses: EnginePulse[],
  start: number,
  end: number,
) {
  let covered = 0;
  for (let n = 1; n < pulses.length; n++) {
    const a = pulses[n - 1]!,
      b = pulses[n]!,
      left = Math.max(start, a.at),
      right = Math.min(end, b.at);
    if (
      a.ready &&
      b.ready &&
      b.at > a.at &&
      b.at - a.at <= JEV_ENGINE_POLICY.sample_max_gap_ms &&
      right > left
    )
      covered += right - left;
  }
  return {
    covered_ms: covered,
    valid: covered === end - start && end > start,
    reasons: [...new Set(pulses.flatMap((p) => p.reasons))],
  };
}
export function engineQualification(input: {
  origin: string;
  start_at: string | null;
  end_at: string;
  valid: boolean;
  exercised: EnginePulse["exercised"];
  financial_gap: boolean;
}) {
  return (
    input.origin === "observed_runtime" &&
    input.valid &&
    !input.financial_gap &&
    input.start_at !== null &&
    Date.parse(input.end_at) - Date.parse(input.start_at) >=
      JEV_ENGINE_POLICY.qualification_ms &&
    Object.values(input.exercised).every(Boolean)
  );
}
async function pulseTx(
  tx: SqlExecutor,
  lease: ExecutionLease,
  model: string | null,
  backendReady: boolean,
  at: number,
): Promise<EnginePulse[]> {
  const sources = await readSourceReadinessTx(tx, new Date(at)),
    registry = await jevDispatchRegistryHashTx(tx);
  const rows = (
    await tx.query<{
      owner_id: string;
      account_id: string;
      binding: Parameters<typeof jevScope>[0];
      instrument: Parameters<typeof jevScope>[1];
      admitted: boolean;
      capacity_evidence_id: string | null;
      cost_evidence_id: string | null;
      risk: Record<string, unknown> | null;
      sequence: string;
      reconciliation: Record<string, unknown> | null;
      state: Record<string, unknown> | null;
      quantity: string;
      execution: boolean;
      funding: boolean;
    }>(`SELECT a.owner_id,a.account_id,b.binding,a.identity->'instrument' AS instrument,c.admitted,c.capacity_evidence_id,c.cost_evidence_id,
 r.checkpoint AS risk,COALESCE(l.sequence,0)::text AS sequence,f.observation AS reconciliation,x.state,
 COALESCE(x.state->'protection'->>'quantity_btc_raw','0') AS quantity,
 EXISTS(SELECT 1 FROM jev_execution_events z WHERE z.account_id=a.account_id AND z.recorded_at>clock_timestamp()-interval '7 days' AND z.result->>'reconciled_flat'='true' AND jsonb_array_length(z.result->'fills')>0) AS execution,
 EXISTS(SELECT 1 FROM jev_funding_receipts z WHERE z.account_id=a.account_id AND z.recorded_at>clock_timestamp()-interval '7 days' AND z.receipt->>'status'='settled') AS funding
 FROM jev_accounts a JOIN jev_worker_controls c USING(account_id) JOIN jev_bindings b USING(account_id)
 LEFT JOIN LATERAL(SELECT checkpoint FROM jev_risk_events WHERE account_id=a.account_id ORDER BY sequence DESC LIMIT 1) r ON true
 LEFT JOIN LATERAL(SELECT sequence FROM jev_ledger_events WHERE account_id=a.account_id ORDER BY sequence DESC LIMIT 1) l ON true
 LEFT JOIN LATERAL(SELECT jsonb_build_object('ledger_sequence',ledger_sequence::text,'funding_through_at',funding_through_at) AS observation FROM jev_risk_reconciliations WHERE account_id=a.account_id ORDER BY recorded_at DESC,operation_id DESC LIMIT 1) f ON true
 LEFT JOIN LATERAL(SELECT state FROM jev_execution_events WHERE account_id=a.account_id ORDER BY sequence DESC LIMIT 1) x ON true
 WHERE c.admitted AND a.mode IN('paper','stress') ORDER BY a.owner_id,a.account_id LIMIT 7`)
  ).rows;
  const result: EnginePulse[] = [];
  for (const owner of new Set(rows.map((r) => r.owner_id))) {
    const accounts = rows.filter((r) => r.owner_id === owner),
      reasons: string[] = [];
    if (accounts.length > 6) reasons.push("account_limit");
    if (!backendReady || !model) reasons.push("backend_unavailable");
    if (
      sources.channels.length !== 2 ||
      sources.channels.some((s) => s.status !== "fresh") ||
      sources.capture?.channels?.trades?.status !== "healthy" ||
      sources.capture.channels.trades.needs_revalidation !== false ||
      sources.capture.history_truncated
    )
      reasons.push("sources_not_fresh");
    let flat = true;
    for (const a of accounts) {
      if (!a.risk || a.risk.history_complete !== true)
        reasons.push("financial_history_unproven");
      if (
        !a.risk ||
        a.risk.ledger_sequence !== a.sequence ||
        at - Date.parse(String(a.risk.observed_at)) > 2000 ||
        Date.parse(String(a.risk.observed_at)) > at
      )
        reasons.push("risk_stale_or_unreconciled");
      if (
        !a.reconciliation ||
        a.reconciliation.ledger_sequence !== a.sequence ||
        Date.parse(String(a.reconciliation.funding_through_at)) <
          Math.floor(at / 3600000) * 3600000
      )
        reasons.push("funding_or_reconciliation_pending");
      if (
        !model ||
        !(await readJevDispatchCapacityTx(
          tx,
          a.capacity_evidence_id,
          registry,
          model,
          at,
        ))
      )
        reasons.push("resources_or_usage_unproven");
      if (!a.cost_evidence_id) reasons.push("tariff_unproven");
      const ledger = await loadJevAccountTx(
          tx,
          owner,
          a.account_id,
          false,
          20000,
        ),
        open = ledger.projection.positions.filter(
          (p) => p.quantity_btc_raw !== "0",
        );
      if (open.length) {
        flat = false;
        const protection = a.state?.protection as
          { position_id: string; quantity_btc_raw: string } | undefined;
        if (
          open.length !== 1 ||
          !protection ||
          protection.position_id !== open[0]!.position_id ||
          BigInt(protection.quantity_btc_raw) !==
            (BigInt(open[0]!.quantity_btc_raw) < 0n
              ? -BigInt(open[0]!.quantity_btc_raw)
              : BigInt(open[0]!.quantity_btc_raw))
        )
          reasons.push("protection_unconfirmed");
      }
      if (a.state && at - Date.parse(String(a.state.observed_at)) > 2000)
        reasons.push("execution_stale");
    }
    const costs = (
      await tx.query<{ unknown: number; known: boolean }>(
        `SELECT COUNT(*) FILTER(WHERE s.cost_usd6 IS NULL)::int AS unknown,COALESCE(bool_or(s.cost_usd6 IS NOT NULL AND s.result->>'attempted'='true' AND s.result->'usage' IS NOT NULL AND r.tariff IS NOT NULL),false) AS known FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin='real' AND r.started_at<$2 AND EXISTS(SELECT 1 FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id AND p.owner_id=$1)`,
        [owner, new Date(at).toISOString()],
      )
    ).rows[0]!;
    if (costs.unknown) reasons.push("cost_unknown");
    if (!costs.known) reasons.push("effective_tariff_and_usage_unproven");
    result.push({
      at,
      ready: !reasons.length,
      reasons: [...new Set(reasons)],
      scope: jevScope(accounts[0]!.binding, accounts[0]!.instrument),
      generation: lease.generation,
      ledger: Object.fromEntries(
        accounts.map((a) => [a.account_id, a.sequence]),
      ),
      flat,
      exercised: {
        execution: accounts.some((a) => a.execution),
        costs: costs.known,
        funding: accounts.some((a) => a.funding),
        risk: accounts.every((a) => !!a.risk),
        recovery: false,
      },
    });
  }
  return result;
}
export function createJevEngineMonitor(
  pool: Pick<DatabasePool, "transaction">,
  lease: ExecutionLease,
  sha: string,
  model: string | null,
  backendReady: boolean,
) {
  const samples = new Map<string, EnginePulse[]>(),
    cuts = new Map<string, number>();
  let last = -Infinity,
    lastFlush = -Infinity,
    persistenceFailed = false;
  return {
    async tick(now = Date.now()) {
      if (now - last < 1000) return;
      last = now;
      const pulses = await pool.transaction(async (tx) => {
        const p = await pulseTx(tx, lease, model, backendReady, now);
        if (persistenceFailed)
          for (const pulse of p) {
            pulse.ready = false;
            pulse.reasons.push("engine_evidence_unavailable");
          }
        await tx.query(
          `INSERT INTO jev_worker_observation(singleton,generation,observed_at,payload) VALUES(true,$1,$2,$3::jsonb) ON CONFLICT(singleton) DO UPDATE SET generation=EXCLUDED.generation,observed_at=EXCLUDED.observed_at,payload=EXCLUDED.payload`,
          [
            lease.generation,
            new Date(now).toISOString(),
            JSON.stringify({
              schema_version: JEV_ENGINE_POLICY.version,
              code_sha: sha,
              engine_fingerprint: engineFingerprint(sha),
              model,
              backend_ready: backendReady,
              rss_bytes: process.memoryUsage().rss,
              cpu: process.cpuUsage(),
              accounts: p.map((p) => ({
                owner_id: p.scope.owner_id,
                ready: p.ready,
                reasons: p.reasons,
              })),
              operational_admission: false,
            }),
          ],
        );
        return p;
      });
      for (const owner of samples.keys())
        if (!pulses.some((p) => p.scope.owner_id === owner)) {
          samples.delete(owner);
          cuts.delete(owner);
        }
      for (const p of pulses) {
        const owner = p.scope.owner_id,
          list = samples.get(owner) ?? [];
        list.push(p);
        samples.set(owner, list);
        if (!cuts.has(owner)) cuts.set(owner, p.at);
      }
      if (!Number.isFinite(lastFlush)) {
        lastFlush = now;
        return;
      }
      if (now - lastFlush < 60000) return;
      lastFlush = now;
      let failure: unknown;
      for (const [owner, list] of samples) {
        const end = list.at(-1)!,
          start = list[0]!,
          cutStart = cuts.get(owner)!,
          cutEnd = end.at - 2000,
          timeline = engineTimeline(list, cutStart, cutEnd);
        if (cutEnd <= cutStart) {
          samples.delete(owner);
          cuts.delete(owner);
          continue;
        }
        try {
          await withBtcRetentionTransaction(pool, async (tx) => {
            const previous = (
              await tx.query<{
                end_at: Date;
                original: Record<string, unknown>;
                engine_fingerprint: string;
              }>(
                `SELECT end_at,original,engine_fingerprint FROM jev_engine_observations WHERE owner_id=$1 ORDER BY end_at DESC LIMIT 1`,
                [owner],
              )
            ).rows[0];
            const fingerprint = engineFingerprint(sha),
              same = previous?.engine_fingerprint === fingerprint;
            const gap = same ? cutStart - previous!.end_at.getTime() : 0;
            const recoverable =
              !!same &&
              previous!.original.valid === true &&
              gap > 0 &&
              gap <= 60000 &&
              start.ready &&
              start.flat &&
              previous!.original.generation !== lease.generation &&
              jevHash(previous!.original.ledger) === jevHash(start.ledger);
            const begin = recoverable ? previous!.end_at.getTime() : cutStart;
            const window = {
              start_at: new Date(begin).toISOString(),
              end_at: new Date(cutEnd).toISOString(),
            };
            const records = (
              await tx.query<{
                object_id: string;
                recorded_at: Date;
                received_at: Date;
                payload: CoverageCapture["payload"];
              }>(
                `SELECT r.object_id,o.recorded_at,r.received_at,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' AND r.received_at>$1::timestamptz-interval '5 seconds' AND r.received_at<=$2 ORDER BY r.received_at,r.object_id LIMIT 513`,
                [window.start_at, new Date(end.at).toISOString()],
              )
            ).rows;
            const q =
              records.length <= 512
                ? jevDurationCoverage(
                    window,
                    records.map((r) => ({
                      ...r,
                      recorded_at: r.recorded_at.toISOString(),
                      received_at: r.received_at.toISOString(),
                    })),
                    new Date(end.at).toISOString(),
                  )
                : null;
            const valid =
              timeline.valid && q !== null && q.covered_ms === cutEnd - begin;
            const continuous =
              same && (previous!.end_at.getTime() === cutStart || recoverable);
            const streak = valid
              ? continuous &&
                typeof previous!.original.streak_start_at === "string"
                ? previous!.original.streak_start_at
                : window.start_at
              : null;
            const prior = (
              valid && continuous && previous!.original.valid
                ? previous!.original.exercised
                : {}
            ) as Partial<EnginePulse["exercised"]>;
            const exercised = { ...end.exercised };
            for (const k of Object.keys(
              exercised,
            ) as (keyof typeof exercised)[])
              exercised[k] = exercised[k] || prior[k] === true;
            exercised.recovery =
              exercised.recovery ||
              (same &&
                previous!.original.generation !== lease.generation &&
                jevHash(previous!.original.ledger) === jevHash(start.ledger) &&
                start.flat);
            const original = {
              origin: "observed_runtime",
              engine_version: JEV_SCHEDULER_VERSION,
              engine_fingerprint: fingerprint,
              code_sha: sha,
              generation: lease.generation,
              ...window,
              valid,
              covered_worker_ms: timeline.covered_ms + (recoverable ? gap : 0),
              recovered_gap_ms: recoverable ? gap : 0,
              source_covered_ms: q?.covered_ms ?? 0,
              streak_start_at: streak,
              ledger: end.ledger,
              exercised,
              reasons: timeline.reasons,
              financial_gap: timeline.reasons.includes(
                "financial_history_unproven",
              ),
            };
            const id = `jev-engine:${jevHash([owner, fingerprint, window])}`;
            await storeJevEvidenceTx(
              tx,
              makeJevEvidence({
                object_id: id,
                scope: end.scope,
                kind: "quality",
                recorded_at: new Date(end.at).toISOString(),
                payload: {
                  ...window,
                  gaps: q?.gaps ?? [],
                  counters: {
                    covered_ms: timeline.covered_ms + (recoverable ? gap : 0),
                    source_covered_ms: q?.covered_ms ?? 0,
                  },
                  original,
                  records: records.map((r) => ({
                    ...r,
                    recorded_at: r.recorded_at.toISOString(),
                    received_at: r.received_at.toISOString(),
                  })),
                },
                dependencies: [],
                sources: [],
              }),
            );
            await tx.query(
              "INSERT INTO jev_engine_observations(evidence_id,owner_id,engine_version,engine_fingerprint,start_at,end_at,valid,streak_start_at,original) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING",
              [
                id,
                owner,
                JEV_SCHEDULER_VERSION,
                fingerprint,
                window.start_at,
                window.end_at,
                valid,
                streak,
                JSON.stringify(original),
              ],
            );
            const qualified = engineQualification({
              origin: "observed_runtime",
              start_at: streak,
              end_at: window.end_at,
              valid,
              exercised,
              financial_gap: original.financial_gap,
            });
            const previousQualification = (
              await tx.query<{
                qualified: boolean;
                end_at: Date;
                envelope: {
                  payload: { original: { engine_fingerprint: string } };
                };
              }>(
                `SELECT q.qualified,q.end_at,e.envelope FROM jev_engine_qualifications q JOIN jev_evidence_objects e ON e.object_id=q.evidence_id WHERE q.owner_id=$1 ORDER BY end_at DESC LIMIT 1`,
                [owner],
              )
            ).rows[0];
            if (
              !previousQualification ||
              previousQualification.qualified !== qualified ||
              previousQualification.envelope.payload.original
                .engine_fingerprint !== fingerprint ||
              previousQualification.end_at.toISOString().slice(0, 10) !==
                window.end_at.slice(0, 10)
            ) {
              let begin = qualified ? streak! : window.start_at;
              const dependencies = qualified
                ? (
                    await tx.query<{ evidence_id: string }>(
                      `SELECT evidence_id,start_at FROM jev_engine_observations WHERE owner_id=$1 AND engine_fingerprint=$2 AND end_at>$3 AND end_at<=$4 ORDER BY end_at LIMIT 12001`,
                      [
                        owner,
                        fingerprint,
                        new Date(
                          Date.parse(window.end_at) -
                            JEV_ENGINE_POLICY.qualification_ms,
                        ).toISOString(),
                        window.end_at,
                      ],
                    )
                  ).rows.map((r) => r.evidence_id)
                : [id];
              if (qualified && dependencies.length)
                begin = (
                  await tx.query<{ start_at: Date }>(
                    "SELECT start_at FROM jev_engine_observations WHERE evidence_id=$1",
                    [dependencies[0]],
                  )
                ).rows[0]!.start_at.toISOString();
              if (dependencies.length > 12000)
                throw new Error("JEV_ENGINE_QUALIFICATION_LIMIT");
              const result = {
                schema_version: "jev.engine-qualification.v1",
                engine_version: JEV_SCHEDULER_VERSION,
                engine_fingerprint: fingerprint,
                start_at: begin,
                end_at: window.end_at,
                qualified,
                financial_continuity_proven: valid,
                execution_costs_funding_risk_recovery_proven:
                  Object.values(exercised).every(Boolean),
                origin: "observed_runtime",
                code_sha: sha,
                exercised,
              };
              const qid = `jev-engine-qualification:${jevHash([owner, result])}`;
              await storeJevEvidenceTx(
                tx,
                makeJevEvidence({
                  object_id: qid,
                  scope: end.scope,
                  kind: "result",
                  recorded_at: new Date(end.at).toISOString(),
                  payload: { artifact_id: qid, original: result },
                  dependencies,
                  sources: [],
                }),
              );
              await tx.query(
                "INSERT INTO jev_engine_qualifications(evidence_id,owner_id,engine_version,start_at,end_at,qualified) VALUES($1,$2,$3,$4,$5,$6)",
                [
                  qid,
                  owner,
                  JEV_SCHEDULER_VERSION,
                  begin,
                  window.end_at,
                  qualified,
                ],
              );
            }
          });
        } catch (error) {
          failure = error;
        } finally {
          // Bound memory even when persistence is refused. A subsequent missing segment resets the streak.
          samples.set(
            owner,
            list.filter(
              (p) => p.at >= cutEnd - JEV_ENGINE_POLICY.sample_max_gap_ms,
            ),
          );
          cuts.set(owner, cutEnd);
        }
      }
      persistenceFailed = failure !== undefined;
      if (failure) throw failure;
    },
  };
}

export async function readJevReadinessTx(
  tx: SqlExecutor,
  owner: string,
  at: string,
) {
  const w = (
    await tx.query<{
      payload: {
        code_sha: string;
        engine_fingerprint: string;
        backend_ready: boolean;
        rss_bytes: number;
        cpu: { user: number; system: number };
        accounts: { owner_id: string; ready: boolean; reasons: string[] }[];
      };
      observed_at: Date;
      lease_alive: boolean;
      generation_matches: boolean;
    }>(
      `SELECT o.payload,o.observed_at,h.lease_until>clock_timestamp() AS lease_alive,h.generation=o.generation AS generation_matches FROM jev_worker_observation o JOIN execution_worker_head h USING(singleton)`,
    )
  ).rows[0];
  const reasons: string[] = [];
  const age = w ? Date.parse(at) - w.observed_at.getTime() : Infinity;
  if (!w || age < 0 || age > 5000 || !w.lease_alive || !w.generation_matches)
    reasons.push("worker_unavailable_or_stale");
  const account = w?.payload.accounts.find((a) => a.owner_id === owner);
  if (!account) reasons.push("not_admitted");
  else reasons.push(...account.reasons);
  if (!w?.payload.backend_ready) reasons.push("backend_unavailable");
  const observation = (
    await tx.query<{
      original: {
        streak_start_at: string | null;
        end_at: string;
        valid: boolean;
        reasons: string[];
        exercised: EnginePulse["exercised"];
      };
      engine_fingerprint: string;
      evidence_id: string;
    }>(
      `SELECT original,engine_fingerprint,evidence_id FROM jev_engine_observations WHERE owner_id=$1 ORDER BY end_at DESC LIMIT 1`,
      [owner],
    )
  ).rows[0];
  const q = (
    await tx.query<{
      qualified: boolean;
      evidence_id: string;
      start_at: Date;
      end_at: Date;
      engine_version: string;
      fingerprint: string;
    }>(
      `SELECT q.*,e.envelope->'payload'->'original'->>'engine_fingerprint' AS fingerprint FROM jev_engine_qualifications q JOIN jev_evidence_objects e ON e.object_id=q.evidence_id WHERE q.owner_id=$1 ORDER BY end_at DESC,evidence_id DESC LIMIT 1`,
      [owner],
    )
  ).rows[0];
  const observationAge = observation
    ? Date.parse(at) - Date.parse(observation.original.end_at)
    : Infinity;
  if (account && (!observation || observationAge < 0 || observationAge > 90000))
    reasons.push("engine_evidence_unavailable");
  const qualified =
    !reasons.length &&
    !!observation?.original.valid &&
    q?.qualified === true &&
    q.fingerprint === w?.payload.engine_fingerprint &&
    observation.engine_fingerprint === q.fingerprint;
  return {
    schema_version: JEV_ENGINE_POLICY.version,
    status: reasons.length ? "not_ready" : "technical_ready",
    reasons: [...new Set(reasons)],
    observed_at: w?.observed_at.toISOString() ?? null,
    engine_version: JEV_SCHEDULER_VERSION,
    code_sha: w?.payload.code_sha ?? null,
    resources: w
      ? {
          scope: "execution_worker_process_only",
          rss_bytes: w.payload.rss_bytes,
          cpu_user_us: w.payload.cpu.user,
          cpu_system_us: w.payload.cpu.system,
        }
      : null,
    qualification: {
      status: qualified
        ? "qualified"
        : observation
          ? "observing"
          : "not_started",
      qualified,
      start_at: observation?.original.streak_start_at ?? null,
      end_at: observation?.original.end_at ?? null,
      evidence_id: qualified
        ? q!.evidence_id
        : (observation?.evidence_id ?? null),
      exercised: observation?.original.exercised ?? null,
    },
    operational_admission: false as const,
  };
}
