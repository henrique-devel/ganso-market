import {
  requireJev,
  assertJevOwnership,
  type JevScope,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  startJevBenchmark,
  advanceJevBenchmark,
  type BenchmarkFunding,
} from "./jev-benchmark-engine.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { loadJevAccountTx } from "./jev-store.js";
import { readValuationMarketTx } from "./valuationstore.js";
import { makeJevEvidence, storeJevEvidenceTx } from "./jev-evidence.js";
import { jevHash } from "./jev-hash.js";
import { currentBudgetMs } from "../budgets.js";
export interface JevBenchmarkCut extends ReturnType<
  typeof advanceJevBenchmark
> {
  scope: JevScope;
  parent_id: string | null;
}
export async function indexJevResultTx(
  tx: SqlExecutor,
  scope: JevScope,
  kind: "metrics" | "benchmark",
  id: string,
  operation: string,
  hash: string,
  at: string,
  parent: string | null = null,
) {
  await tx.query(
    `INSERT INTO jev_result_cuts(evidence_id,owner_id,account_id,mode,profile_id,profile_version,experiment_id,kind,sequence,operation_id,request_hash,parent_id,as_of)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,COALESCE(MAX(sequence),0)+1,$9,$10,$11,$12 FROM jev_result_cuts WHERE account_id=$3 AND kind=$8`,
    [
      id,
      scope.owner_id,
      scope.account_id,
      scope.mode,
      scope.profile_id,
      scope.profile_version,
      scope.experiment_id,
      kind,
      operation,
      hash,
      parent,
      at,
    ],
  );
}
/** Unactivated library writer. Reads market originals under the retention
 * lock, persists independent simulation, and never sends a venue order. */
export async function captureJevBenchmark(
  pool: Pick<DatabasePool, "transaction">,
  scope: JevScope,
  operation: string,
  funding: readonly BenchmarkFunding[] = [],
) {
  requireJev(
    scope.mode !== "live" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(operation),
    "BENCHMARK_COMMAND",
  );
  const frozen = structuredClone(funding),
    hash = jevHash({ scope, operation, funding: frozen });
  return withBtcRetentionTransaction(pool, async (tx) => {
    const ledger = await loadJevAccountTx(
      tx,
      scope.owner_id,
      scope.account_id,
      false,
      20000,
    );
    const b = ledger.identity.bindings.find(
      (p) => p.binding.experiment_id === scope.experiment_id,
    );
    requireJev(b, "BENCHMARK_BINDING");
    assertJevOwnership(scope, b.binding, ledger.identity.account, b.profile);
    const prior = (
      await tx.query<{
        request_hash: string;
        envelope: { payload: { original: JevBenchmarkCut } };
      }>(
        "SELECT c.request_hash,e.envelope FROM jev_result_cuts c JOIN jev_evidence_objects e ON e.object_id=c.evidence_id WHERE c.account_id=$1 AND c.kind='benchmark' AND c.operation_id=$2",
        [scope.account_id, operation],
      )
    ).rows[0];
    if (prior) {
      requireJev(prior.request_hash === hash, "BENCHMARK_IDEMPOTENCY");
      return prior.envelope.payload.original;
    }
    const last = (
      await tx.query<{
        evidence_id: string;
        envelope: { payload: { original: JevBenchmarkCut } };
      }>(
        "SELECT c.evidence_id,e.envelope FROM jev_result_cuts c JOIN jev_evidence_objects e ON e.object_id=c.evidence_id WHERE c.account_id=$1 AND c.kind='benchmark' ORDER BY c.sequence DESC LIMIT 1",
        [scope.account_id],
      )
    ).rows[0];
    requireJev(
      !last || jevHash(last.envelope.payload.original.scope) === jevHash(scope),
      "BENCHMARK_LIFETIME_SCOPE",
    );
    const at = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString();
    const market = { as_of: at, ...(await readValuationMarketTx(tx, at)) };
    const meta = (
      await tx.query<{ object_id: string; payload: TradingInstrumentMetadata }>(
        "SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='metadata' AND r.received_at<=$1 ORDER BY r.received_at DESC,r.object_id LIMIT 1",
        [at],
      )
    ).rows[0];
    requireJev(meta, "BENCHMARK_METADATA");
    requireJev(
      meta.payload.instrument.instrument_version === scope.instrument_version,
      "BENCHMARK_INSTRUMENT",
    );
    for (const f of frozen)
      if (f.oracle) {
        const row = (
          await tx.query(
            "SELECT payload FROM btc_retention_objects WHERE object_id=$1",
            [f.oracle.object_id],
          )
        ).rows[0];
        requireJev(
          row && jevHash(row.payload) === jevHash(f.oracle.payload),
          "BENCHMARK_ORACLE_ORIGINAL",
        );
      }
    const result: JevBenchmarkCut = {
      scope,
      parent_id: last?.evidence_id ?? null,
      ...advanceJevBenchmark(
        last?.envelope.payload.original.state ??
          startJevBenchmark(
            scope.mode as "paper" | "stress",
            meta.payload,
            market,
            jevHash(scope),
          ),
        meta.payload,
        market,
        frozen,
      ),
    };
    const id = `jev-benchmark:${scope.account_id}:${operation}`;
    await storeJevEvidenceTx(
      tx,
      makeJevEvidence({
        object_id: id,
        scope,
        kind: "result",
        recorded_at: at,
        payload: {
          artifact_id: id,
          original: result,
          inputs: { metadata: meta.payload, market, funding: frozen },
        },
        dependencies: last ? [last.evidence_id] : [],
        sources: [
          meta.object_id,
          market.book?.object_id,
          market.context?.object_id,
          ...frozen.map((f) => f.oracle?.object_id),
        ]
          .filter((v): v is string => !!v)
          .filter((v, i, a) => a.indexOf(v) === i),
      }),
    );
    await indexJevResultTx(
      tx,
      scope,
      "benchmark",
      id,
      operation,
      hash,
      at,
      last?.evidence_id ?? null,
    );
    return result;
  });
}
export async function readJevResult(
  pool: Pick<DatabasePool, "readOnly">,
  owner: string,
  id: string,
) {
  return pool.readOnly(currentBudgetMs() ?? 4000, async (tx) => {
    const row = (
      await tx.query<{ envelope: { payload: { original: unknown } } }>(
        "SELECT e.envelope FROM jev_result_cuts c JOIN jev_evidence_objects e ON e.object_id=c.evidence_id WHERE c.evidence_id=$1 AND c.owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    requireJev(row, "RESULT_NOT_FOUND");
    return row.envelope.payload.original;
  });
}
export async function readJevBenchmark(
  pool: Pick<DatabasePool, "readOnly">,
  owner: string,
  account: string,
) {
  return pool.readOnly(currentBudgetMs() ?? 4000, async (tx) => {
    requireJev(
      (
        await tx.query(
          "SELECT 1 FROM jev_accounts WHERE owner_id=$1 AND account_id=$2 AND mode IN('paper','stress')",
          [owner, account],
        )
      ).rows.length,
      "ACCOUNT_NOT_FOUND",
    );
    const rows = (
      await tx.query<{
        evidence_id: string;
        envelope: { payload: { original: JevBenchmarkCut } };
      }>(
        "SELECT c.evidence_id,e.envelope FROM jev_result_cuts c JOIN jev_evidence_objects e ON e.object_id=c.evidence_id WHERE c.owner_id=$1 AND c.account_id=$2 AND c.kind='benchmark' ORDER BY c.sequence DESC LIMIT 1",
        [owner, account],
      )
    ).rows;
    return {
      cash: { capital_usd6: "250000000", pnl_usd6: "0", remunerated: false },
      btc_protected: rows[0]
        ? {
            evidence_id: rows[0].evidence_id,
            ...rows[0].envelope.payload.original,
          }
        : null,
      status: rows.length ? "captured" : "not_started",
      real_capital_reserved_usd6: "0",
    };
  });
}
