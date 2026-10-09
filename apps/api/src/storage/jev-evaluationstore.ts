import { readJevReadinessTx } from "./jev-readiness.js";
import { requireJev } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { currentBudgetMs } from "../budgets.js";
import { loadJevAccountTx } from "./jev-store.js";
import { jevScope } from "./jev-ledger.js";
import { jevHash } from "./jev-hash.js";
import { jevTime } from "./jev-context.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { makeJevEvidence, storeJevEvidenceTx } from "./jev-evidence.js";
import {
  readJevCostsTx,
  jevHistoricalMetrics,
  jevMetricsWindow,
} from "./jev-metrics.js";
import { readValuationMarketTx } from "./valuationstore.js";
import {
  jevBenchmarkWindow,
  jevBenchmarkValuationAt,
} from "./jev-benchmark-engine.js";
import type { JevBenchmarkCut } from "./jev-benchmarkstore.js";
import {
  JEV_EVALUATION_POLICY,
  jevDurationCoverage,
  jevEpisodes,
  evaluateJevProfile,
  jevEvaluationWindow,
  mergeIntervals,
  intervalDuration,
  type CoverageCapture,
  type EvaluationAccount,
  type JevEvaluation,
} from "./jev-evaluation.js";
import type { JevRiskCheckpoint } from "../trading/jev-risk.js";

const engineVersion = "jev.scheduler.v2";
type Writer = Pick<DatabasePool, "transaction">;
/** Small immutable elapsed-time segments. Original collector health clocks
 * are copied into protected quality evidence; JEV calls never enter this path. */
export async function captureJevCoverage(
  pool: Writer,
  owner: string,
  account: string,
) {
  return withBtcRetentionTransaction(pool, async (tx) => {
    const l = await loadJevAccountTx(tx, owner, account, false, 20000),
      s = jevScope(l.identity.bindings[0]!.binding, l.identity.instrument);
    const now = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString();
    const end =
      Math.floor(
        (jevTime(now) - JEV_EVALUATION_POLICY.coverage_settlement_delay_ms) /
          60000,
      ) * 60000;
    const knowledge_at = new Date(
      end + JEV_EVALUATION_POLICY.coverage_settlement_delay_ms,
    ).toISOString();
    const last = (
      await tx.query<{ end_at: Date; evidence_id: string }>(
        "SELECT end_at,evidence_id FROM jev_coverage_segments WHERE account_id=$1 ORDER BY end_at DESC LIMIT 1",
        [account],
      )
    ).rows[0];
    if (last && last.end_at.getTime() >= end)
      return { status: "already_captured" as const };
    const start = Math.max(
      jevTime(l.identity.bindings[0]!.binding.started_at),
      last?.end_at.getTime() ?? end - 60000,
      end - 60000,
    );
    if (start >= end) return { status: "not_due" as const };
    const window = {
      start_at: new Date(start).toISOString(),
      end_at: new Date(end).toISOString(),
    };
    const rows = (
      await tx.query<{
        object_id: string;
        recorded_at: Date;
        received_at: Date;
        payload: CoverageCapture["payload"];
      }>(
        `SELECT r.object_id,o.recorded_at,r.received_at,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
       WHERE r.kind='capture' AND r.received_at>$1::timestamptz-interval '5 seconds' AND r.received_at<=$2 AND o.recorded_at<=$2
       AND o.identity->>'instrument_version'=$3 ORDER BY r.received_at,r.object_id LIMIT 513`,
        [window.start_at, knowledge_at, s.instrument_version],
      )
    ).rows;
    requireJev(rows.length <= 512, "COVERAGE_LIMIT");
    const records = rows.map((r) => ({
      ...r,
      recorded_at: r.recorded_at.toISOString(),
      received_at: r.received_at.toISOString(),
    }));
    const q = jevDurationCoverage(window, records, knowledge_at),
      id = `jev-coverage:${account}:${end}`;
    await storeJevEvidenceTx(
      tx,
      makeJevEvidence({
        object_id: id,
        scope: s,
        kind: "quality",
        recorded_at: now,
        payload: {
          start_at: window.start_at,
          end_at: window.end_at,
          gaps: q.gaps,
          counters: {
            denominator_ms: q.denominator_ms,
            covered_ms: q.covered_ms,
          },
          original: q,
          records,
        },
        dependencies: [],
        sources: [],
      }),
    );
    await tx.query(
      "INSERT INTO jev_coverage_segments(evidence_id,account_id,start_at,end_at,covered_ms) VALUES($1,$2,$3,$4,$5)",
      [id, account, window.start_at, window.end_at, q.covered_ms],
    );
    return { status: "captured" as const, evidence_id: id, quality: q };
  });
}
export async function readJevCoverageTx(
  tx: SqlExecutor,
  account: string,
  window: { start_at: string; end_at: string },
) {
  const interior = (
    await tx.query<{ covered_ms: string; segments: number }>(
      `SELECT COALESCE(SUM(covered_ms),0)::text AS covered_ms,COUNT(*)::int AS segments FROM jev_coverage_segments WHERE account_id=$1 AND start_at>=$2 AND end_at<=$3`,
      [account, window.start_at, window.end_at],
    )
  ).rows[0]!;
  const boundaries = (
    await tx.query<{
      envelope: {
        payload: { original: ReturnType<typeof jevDurationCoverage> };
      };
    }>(
      `SELECT e.envelope FROM jev_coverage_segments c JOIN jev_evidence_objects e ON e.object_id=c.evidence_id WHERE c.account_id=$1 AND c.end_at>$2 AND c.start_at<$3 AND (c.start_at<$2 OR c.end_at>$3) ORDER BY c.start_at LIMIT 3`,
      [account, window.start_at, window.end_at],
    )
  ).rows;
  requireJev(boundaries.length <= 2, "COVERAGE_OVERLAP");
  const clipped = mergeIntervals(
    boundaries.flatMap((r) => r.envelope.payload.original.valid_intervals),
    jevTime(window.start_at),
    jevTime(window.end_at),
  );
  const denominator = jevTime(window.end_at) - jevTime(window.start_at),
    covered = Number(interior.covered_ms) + intervalDuration(clipped);
  requireJev(covered <= denominator, "COVERAGE_OVERCOUNT");
  return {
    schema_version: JEV_EVALUATION_POLICY.coverage_version,
    window,
    denominator_ms: denominator,
    covered_ms: covered,
    segments: interior.segments + boundaries.length,
    coverage_ppm: Math.floor((covered * 1000000) / denominator),
    missing_ms: denominator - covered,
  };
}
async function accountInputTx(
  tx: SqlExecutor,
  owner: string,
  account: string,
  window: { start_at: string; end_at: string },
  dependencies: string[],
  knowledge_at: string,
  sources: string[],
) {
  const l = await loadJevAccountTx(tx, owner, account, false, 20000),
    b = l.identity.bindings[0]!,
    s = jevScope(b.binding, l.identity.instrument);
  requireJev(
    l.identity.bindings.length === 1 && s.mode !== "live",
    "EVALUATION_BINDING",
  );
  const quality = await readJevCoverageTx(tx, account, window);
  const reconciliation = (
    await tx.query<{ ledger_sequence: string; funding_through_at: Date }>(
      "SELECT ledger_sequence::text,funding_through_at FROM jev_risk_reconciliations WHERE account_id=$1 ORDER BY recorded_at DESC,operation_id DESC LIMIT 1",
      [account],
    )
  ).rows[0];
  const metrics = async (at: string) => {
    // Both original event time and knowledge/receive time form the cut.
    const events = l.events.filter((e) => e.occurred_at <= at);
    const fundingComplete =
      !events.some((e) => e.payload.event_type === "fill") ||
      (!!reconciliation &&
        reconciliation.ledger_sequence === l.projection.last_sequence &&
        reconciliation.funding_through_at.getTime() >=
          Math.floor(jevTime(at) / 3600000) * 3600000);
    const market = { as_of: at, ...(await readValuationMarketTx(tx, at)) };
    for (const id of [market.context?.object_id, market.book?.object_id])
      if (id) sources.push(id);
    return jevHistoricalMetrics(
      l.identity,
      l.events,
      market,
      await readJevCostsTx(tx, s, "real", at),
      fundingComplete,
      knowledge_at,
    );
  };
  const opening = await metrics(window.start_at),
    closing = await metrics(window.end_at),
    economic = jevMetricsWindow(opening, closing);
  const episodes = jevEpisodes(l.identity, l.events, s, window, knowledge_at);
  const risk = (
    await tx.query<{ checkpoint: JevRiskCheckpoint }>(
      "SELECT checkpoint FROM jev_risk_events WHERE account_id=$1 AND (checkpoint->>'observed_at')::timestamptz<=$2 ORDER BY sequence DESC LIMIT 1",
      [account, knowledge_at],
    )
  ).rows[0]?.checkpoint;
  // Immutable earlier failures survive restarts, window rollover and a later
  // healthy checkpoint. Missing financial history is never an economic loss.
  const failures = (
    await tx.query<{ gap: boolean; failure: boolean }>(
      `SELECT COALESCE(bool_or(checkpoint->>'history_complete'='false'),FALSE) AS gap,
    COALESCE(bool_or(checkpoint->>'drawdown_blocked'='true' OR checkpoint->>'daily_pause_day' IS NOT NULL),FALSE) AS failure
    FROM jev_risk_events WHERE account_id=$1 AND (checkpoint->>'observed_at')::timestamptz<=$2`,
      [account, knowledge_at],
    )
  ).rows[0]!;
  const ref = async (at: string) => {
    const r = (
      await tx.query<{
        evidence_id: string;
        envelope: { payload: { original: JevBenchmarkCut } };
      }>(
        "SELECT c.evidence_id,e.envelope FROM jev_result_cuts c JOIN jev_evidence_objects e ON e.object_id=c.evidence_id WHERE c.account_id=$1 AND c.kind='benchmark' AND c.as_of<=$2 AND c.profile_version=$3 ORDER BY c.sequence DESC LIMIT 1",
        [account, knowledge_at, s.profile_version],
      )
    ).rows[0];
    if (r) dependencies.push(r.evidence_id);
    const state = r?.envelope.payload.original.state;
    return state && state.started_at <= at && state.observed_at >= at
      ? jevBenchmarkValuationAt(
          state,
          { as_of: at, ...(await readValuationMarketTx(tx, at)) },
          knowledge_at,
        )
      : null;
  };
  const [first, last] = await Promise.all([
    ref(window.start_at),
    ref(window.end_at),
  ]);
  const benchmark = first && last ? jevBenchmarkWindow(first, last) : null;
  const interventions =
    (
      await tx.query(
        `SELECT 1 FROM jev_operator_commands WHERE owner_id=$1 AND $2=ANY(account_ids) AND recorded_at<=$3 LIMIT 1`,
        [owner, account, knowledge_at],
      )
    ).rowCount > 0;
  const input: EvaluationAccount = {
    scope: s,
    manifest_hash: b.profile.manifest_hash,
    started_at: b.binding.started_at,
    episodes: episodes.closed_count,
    denominator_ms: quality.denominator_ms,
    covered_ms: quality.covered_ms,
    costs_complete:
      opening.costs.evaluation.jev_usd6 !== null &&
      closing.costs.evaluation.jev_usd6 !== null,
    reconciled:
      !interventions &&
      !!risk &&
      risk.history_complete &&
      risk.ledger_sequence === l.projection.last_sequence &&
      reconciliation?.ledger_sequence === l.projection.last_sequence &&
      closing.trading.funding_complete,
    irrecoverable_financial_gap: failures.gap,
    proven_risk_failure: failures.failure,
    conservative_usd6: economic.conservative_result_usd6,
    benchmark_usd6: benchmark?.btc_protected.pnl_usd6 ?? null,
  };
  return {
    input,
    evidence: {
      episodes,
      quality,
      opening,
      closing,
      economic,
      benchmark,
      risk: risk ?? null,
      failures,
      interventions,
    },
  };
}
/** Fresh prospective assessment; no daily cut is treated as permanent approval. */
export async function assessJevProfileTx(
  tx: SqlExecutor,
  owner: string,
  profile: string,
  version: string,
  now: string,
) {
  const bindings = (
    await tx.query<{ account_id: string; binding: { started_at: string } }>(
      "SELECT account_id,binding FROM jev_bindings WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3 AND mode IN('paper','stress') ORDER BY mode",
      [owner, profile, version],
    )
  ).rows;
  requireJev(bindings.length === 2, "EVALUATION_PAIR");
  const end =
    Date.parse(now) - JEV_EVALUATION_POLICY.coverage_settlement_delay_ms;
  const begun = Date.parse(bindings[0]!.binding.started_at);
  requireJev(end > begun, "EVALUATION_WINDOW");
  const full = end - begun >= 90 * 86400000;
  const window = {
    start_at: new Date(full ? end - 90 * 86400000 : begun).toISOString(),
    end_at: new Date(end).toISOString(),
  };
  const dependencies: string[] = [],
    sources: string[] = [];
  const accounts = [];
  for (const b of bindings) {
    const current = (
      await accountInputTx(
        tx,
        owner,
        b.account_id,
        window,
        dependencies,
        now,
        sources,
      )
    ).input;
    // The duration proof settles two seconds behind the clock. New financial
    // events/corrections and new/uncertain JEV bills must settle before this
    // otherwise favorable cut may authorize promotion or signing.
    const changes = !!(
      await tx.query(
        "SELECT 1 FROM jev_ledger_events WHERE account_id=$1 AND ((event->>'occurred_at')::timestamptz>$2 OR (event->>'recorded_at')::timestamptz>$2) LIMIT 1",
        [b.account_id, window.end_at],
      )
    ).rowCount;
    const closed = !!(
      await tx.query(
        "SELECT 1 FROM jev_evidence_closures c JOIN jev_bindings b USING(experiment_id) WHERE b.account_id=$1 AND c.closed_at<=$2 LIMIT 1",
        [b.account_id, now],
      )
    ).rowCount;
    if (changes || closed) current.reconciled = false;
    const pending = !!(
      await tx.query(
        `SELECT 1 FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin='real' AND (r.started_at>$2 OR s.finished_at>$2 OR s.cost_usd6 IS NULL) AND EXISTS(SELECT 1 FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id AND p.account_id=$1)
      UNION ALL SELECT 1 FROM jev_proposal_requests r JOIN jev_proposals p USING(owner_id,proposal_id) LEFT JOIN jev_proposal_results s USING(origin,request_id) WHERE r.origin='real' AND (r.started_at>$2 OR s.finished_at>$2 OR s.cost_usd6 IS NULL) AND p.owner_id=$3 AND p.profile_id=$4 AND p.profile_version=$5 LIMIT 1`,
        [b.account_id, window.end_at, owner, profile, version],
      )
    ).rowCount;
    if (pending) current.costs_complete = false;
    accounts.push(current);
  }
  const previous_failed = !!(
    await tx.query(
      "SELECT 1 FROM jev_evaluation_cuts WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3 AND state='failed' AND as_of<=$4 LIMIT 1",
      [owner, profile, version, now],
    )
  ).rowCount;
  const readiness = await readJevReadinessTx(tx, owner, now);
  return {
    result: evaluateJevProfile({
      as_of: window.end_at,
      window,
      phase: full ? "rolling90" : "initial",
      accounts,
      previous_failed,
      engine_qualified: readiness.qualification.qualified,
    }),
    dependencies,
    sources,
  };
}
export async function captureJevEvaluation(
  pool: Writer,
  owner: string,
  profile: string,
  version: string,
  selection?: {
    phase: "initial" | "preview30" | "rolling90";
    window: { start_at: string; end_at: string };
  },
) {
  return withBtcRetentionTransaction(pool, async (tx) => {
    const bindings = (
      await tx.query<{ account_id: string; binding: { started_at: string } }>(
        "SELECT account_id,binding FROM jev_bindings WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3 AND mode IN('paper','stress') ORDER BY mode",
        [owner, profile, version],
      )
    ).rows;
    requireJev(bindings.length === 2, "EVALUATION_PAIR");
    const now = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString();
    const canonical = jevEvaluationWindow(bindings[0]!.binding.started_at, now);
    if (!canonical) {
      requireJev(!selection, "EVALUATION_SCHEDULE");
      return null;
    }
    const selected = selection ?? canonical;
    requireJev(
      selected.window.end_at === canonical.window.end_at &&
        (selected.phase === "preview30"
          ? jevTime(selected.window.end_at) -
              jevTime(selected.window.start_at) ===
              30 * 86400000 &&
            jevTime(selected.window.start_at) >=
              jevTime(bindings[0]!.binding.started_at)
          : jevHash(selected) === jevHash(canonical)),
      "EVALUATION_SCHEDULE",
    );
    requireJev(
      jevTime(selected.window.end_at) <= jevTime(now),
      "EVALUATION_FUTURE",
    );
    const id = `jev-evaluation:${jevHash([owner, profile, version, selected.phase, selected.window])}`;
    const prior = (
      await tx.query<{ envelope: { payload: { original: JevEvaluation } } }>(
        "SELECT envelope FROM jev_evidence_objects WHERE object_id=$1",
        [id],
      )
    ).rows[0];
    if (prior) return prior.envelope.payload.original;
    const dependencies: string[] = [];
    const sources: string[] = [];
    const results = [];
    for (const b of bindings)
      results.push(
        await accountInputTx(
          tx,
          owner,
          b.account_id,
          selected.window,
          dependencies,
          now,
          sources,
        ),
      );
    const q = (
      await tx.query<{ evidence_id: string; qualified: boolean }>(
        `SELECT q.evidence_id,(q.qualified AND EXISTS(SELECT 1 FROM jev_worker_observation o WHERE o.observed_at>clock_timestamp()-interval '5 seconds' AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.payload->'accounts') a WHERE a->>'owner_id'=$1 AND a->>'ready'='true')) AND NOT EXISTS(SELECT 1 FROM jev_risk_events r JOIN jev_accounts a USING(account_id) WHERE a.owner_id=$1 AND r.checkpoint->>'history_complete'='false')) AS qualified FROM jev_engine_qualifications q WHERE q.owner_id=$1 AND q.engine_version=$2 AND q.end_at<=$3 AND EXISTS(SELECT 1 FROM execution_worker_head h JOIN execution_worker_owners w USING(generation) JOIN jev_evidence_objects e ON e.object_id=q.evidence_id WHERE h.singleton AND h.lease_until>clock_timestamp() AND e.envelope->'payload'->'original'->>'code_sha'=w.code_sha) ORDER BY q.end_at DESC,q.evidence_id DESC LIMIT 1`,
        [owner, engineVersion, selected.window.end_at],
      )
    ).rows[0];
    const readiness = await readJevReadinessTx(tx, owner, now);
    if (q) dependencies.push(q.evidence_id);
    const previous = (
      await tx.query<{ evidence_id: string }>(
        "SELECT evidence_id FROM jev_evaluation_cuts WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3 AND state='failed' ORDER BY as_of DESC LIMIT 1",
        [owner, profile, version],
      )
    ).rows[0];
    if (previous) dependencies.push(previous.evidence_id);
    const result = evaluateJevProfile({
      as_of: selected.window.end_at,
      ...selected,
      accounts: results.map((r) => r.input),
      engine_qualified:
        q?.qualified === true && readiness.qualification.qualified,
      previous_failed: !!previous,
    });
    await storeJevEvidenceTx(
      tx,
      makeJevEvidence({
        object_id: id,
        scope: results[0]!.input.scope,
        kind: "result",
        recorded_at: now,
        payload: {
          artifact_id: id,
          original: result,
          inputs: results.map((r) => r.evidence),
        },
        dependencies: [...new Set(dependencies)],
        sources: [...new Set(sources)],
      }),
    );
    await tx.query(
      "INSERT INTO jev_evaluation_cuts(evidence_id,owner_id,profile_id,profile_version,as_of,phase,state) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, owner, profile, version, result.as_of, result.phase, result.state],
    );
    return result;
  });
}
/** Called by the singleton fenced worker only. Admission remains an external
 * prerequisite. No JEV call, venue command or qualification is produced here. */
export async function runJevContinuousEvaluation(pool: Writer) {
  const pairs = await pool.transaction(
    async (tx) =>
      (
        await tx.query<{
          owner_id: string;
          profile_id: string;
          profile_version: string;
          account_id: string;
        }>(
          `SELECT b.owner_id,b.profile_id,b.profile_version,b.account_id FROM jev_bindings b JOIN jev_worker_controls c USING(account_id) WHERE c.admitted AND b.mode IN('paper','stress') ORDER BY b.account_id LIMIT 6`,
        )
      ).rows,
  );
  for (const p of pairs)
    await captureJevCoverage(pool, p.owner_id, p.account_id);
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = jevHash([p.owner_id, p.profile_id, p.profile_version]);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await captureJevEvaluation(
      pool,
      p.owner_id,
      p.profile_id,
      p.profile_version,
    );
    if (
      result &&
      result.phase === "initial" &&
      jevTime(result.as_of) - jevTime(result.window.start_at) >= 30 * 86400000
    ) {
      await captureJevEvaluation(
        pool,
        p.owner_id,
        p.profile_id,
        p.profile_version,
        {
          phase: "preview30",
          window: {
            start_at: new Date(
              jevTime(result.as_of) - 30 * 86400000,
            ).toISOString(),
            end_at: result.as_of,
          },
        },
      );
    }
  }
  return { admitted_accounts: pairs.length };
}
export async function readJevEvaluation(
  pool: Pick<DatabasePool, "readOnly">,
  owner: string,
  profile: string,
  version: string,
) {
  return pool.readOnly(currentBudgetMs() ?? 1500, async (tx) => {
    requireJev(
      (
        await tx.query(
          "SELECT 1 FROM jev_profiles WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3",
          [owner, profile, version],
        )
      ).rowCount,
      "RESULT_NOT_FOUND",
    );
    const rows = (
      await tx.query<{
        evidence_id: string;
        envelope: { payload: { original: JevEvaluation } };
      }>(
        `SELECT c.evidence_id,e.envelope FROM jev_evaluation_cuts c JOIN jev_evidence_objects e ON e.object_id=c.evidence_id WHERE c.owner_id=$1 AND c.profile_id=$2 AND c.profile_version=$3 ORDER BY c.as_of DESC,c.phase LIMIT 2`,
        [owner, profile, version],
      )
    ).rows;
    return {
      schema_version: "jev.evaluation-read.v1",
      status: rows.length ? "captured" : "not_started",
      evaluations: rows.map((r) => ({
        evidence_id: r.evidence_id,
        ...r.envelope.payload.original,
      })),
      operational_admission: false,
    };
  });
}
