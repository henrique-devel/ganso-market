import type { DatabasePool, SqlExecutor } from "../database.js";
import { ledgerScope } from "../trading/ledger.js";
import {
  pinRetentionObjectTx,
  storeRetentionObjectTx,
} from "./btc-retention.js";
import {
  REPLAY_CONTRACTS,
  REPLAY_LIMITS,
  REPLAY_VERSION,
  replayDataset,
  replayHash,
  requireReplay,
  sealReplayDataset,
  type ReplayArtifact,
  type ReplayDataset,
  type ReplayEvidence,
  type RetainedReplayRef,
} from "./replay-dataset.js";

/** Fixed SQL projections only; never accepts arbitrary table/column names from CLI. */
async function boundedRows<T>(
  tx: SqlExecutor,
  sql: string,
  account: string,
  limit: number,
  budget: { bytes: number; deadline: number },
  extra: readonly unknown[] = [],
): Promise<T[]> {
  requireReplay(Date.now() < budget.deadline, "WORK_LIMIT");
  // Size is checked server-side before any potentially large JSON reaches Node.
  const rows = await tx.query<{ value: T; bytes: number }>(
    `WITH bounded AS MATERIALIZED (${sql} LIMIT $2)
    SELECT CASE WHEN sum(octet_length(row_to_json(b)::text)) OVER () <= $3 THEN row_to_json(b) ELSE NULL END AS value,
      octet_length(row_to_json(b)::text) AS bytes FROM bounded b`,
    [account, limit + 1, REPLAY_LIMITS.bytes - budget.bytes, ...extra],
  );
  requireReplay(Date.now() < budget.deadline, "WORK_LIMIT");
  requireReplay(rows.rows.length <= limit, "ROW_LIMIT");
  for (const r of rows.rows) {
    budget.bytes += r.bytes;
    requireReplay(
      r.value !== null && budget.bytes <= REPLAY_LIMITS.bytes,
      "BYTE_LIMIT",
    );
  }
  return rows.rows.map((r) => r.value);
}
/** One bounded snapshot per invocation. Lock order matches financial writers.
 * Captures now; never invents an old snapshot from current mutable state. */
export async function captureReplayDataset(
  pool: Pick<DatabasePool, "transaction">,
  account: string,
  codeSha: string,
  decisionIds?: readonly string[],
  evidenceMode: "embedded" | "references" = "embedded",
): Promise<ReplayArtifact> {
  requireReplay(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(account) &&
      /^[a-f0-9]{40}$/.test(codeSha),
    "REQUEST",
  );
  requireReplay(
    !decisionIds ||
      (decisionIds.length > 0 &&
        decisionIds.length <= REPLAY_LIMITS.decisions &&
        new Set(decisionIds).size === decisionIds.length &&
        decisionIds.every((id) => /^[a-f0-9]{64}$/.test(id))),
    "DECISION_SELECTION",
  );
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await tx.query("SET LOCAL statement_timeout = '5s'");
    await tx.query("SET LOCAL lock_timeout = '2s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    await tx.query("SELECT pg_advisory_xact_lock(741044, 4)");
    const started = Date.now(),
      budget = { bytes: 0, deadline: started + 10000 };
    const rows = await boundedRows<{ identity: ReplayDataset["identity"] }>(
      tx,
      "SELECT identity FROM btc_ledger_accounts WHERE account_id=$1 FOR UPDATE",
      account,
      1,
      budget,
    );
    requireReplay(rows[0], "ACCOUNT_MISSING");
    const at = (
      await tx.query<{ at: Date }>("SELECT clock_timestamp() AS at")
    ).rows[0]!.at.toISOString();
    const ledger = (
      await boundedRows<{ event: ReplayDataset["ledger"][number] }>(
        tx,
        "SELECT event FROM btc_ledger_events WHERE account_id=$1 ORDER BY sequence",
        account,
        REPLAY_LIMITS.rows,
        budget,
      )
    ).map((x) => x.event);
    const reservations = await boundedRows<
      ReplayDataset["reservations"][number]
    >(
      tx,
      "SELECT sequence::text, to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS recorded_at,request,reservation,ledger_transaction_id FROM btc_reservation_events WHERE account_id=$1 ORDER BY sequence",
      account,
      REPLAY_LIMITS.rows,
      budget,
    );
    const selection = decisionIds ? " AND decision_id=ANY($4::text[])" : "";
    const extra = decisionIds ? [decisionIds] : [];
    const decisions = await boundedRows<ReplayDataset["decisions"][number]>(
      tx,
      `SELECT decision,evidence_id FROM btc_baseline_decisions_full WHERE account_id=$1${selection} ORDER BY bar_end_at`,
      account,
      REPLAY_LIMITS.decisions,
      budget,
      extra,
    );
    requireReplay(
      !decisionIds || decisions.length === decisionIds.length,
      "DECISION_SELECTION_MISSING",
    );
    const jev = await boundedRows<ReplayDataset["jev"][number]>(
      tx,
      `SELECT decision_id,evidence_id,state,origin,model,request_id,request,outcome FROM btc_jev_challenger_requests WHERE account_id=$1${selection} ORDER BY bar_end_at`,
      account,
      REPLAY_LIMITS.decisions,
      budget,
      extra,
    );
    requireReplay(
      ["embedded", "references"].includes(evidenceMode),
      "EVIDENCE_MODE",
    );
    const roots = new Set<string>();
    const embedded = new Set(decisions.map((d) => d.evidence_id));
    // Indexed by account. Do not scan the marketstore or historical raw feed.
    for (const table of [
      "btc_baseline_registrations",
      "btc_baseline_events",
      "btc_ioc_intents",
      "btc_ioc_results",
      "btc_passive_results",
      "btc_passive_events",
      "btc_funding_results",
    ]) {
      const records = await boundedRows<{ evidence_id: string }>(
        tx,
        `SELECT evidence_id FROM ${table} WHERE account_id=$1`,
        account,
        REPLAY_LIMITS.rows,
        budget,
      );
      for (const row of records) {
        roots.add(row.evidence_id);
        if (table === "btc_baseline_registrations")
          embedded.add(row.evidence_id);
      }
    }
    for (const d of decisions) roots.add(d.evidence_id);
    for (const j of jev) roots.add(j.evidence_id);
    const refs = [
      ...new Set(
        decisions.flatMap((d) => d.decision.input_refs.map((r) => r.object_id)),
      ),
    ];
    requireReplay(refs.length <= REPLAY_LIMITS.objects, "OBJECT_LIMIT");
    // Missing legacy references are retained as fidelity warnings, not fabricated.
    if (refs.length)
      for (const row of (
        await tx.query<{ object_id: string }>(
          "SELECT object_id FROM btc_retention_objects WHERE object_id=ANY($1::text[])",
          [refs],
        )
      ).rows)
        roots.add(row.object_id);
    requireReplay(roots.size <= REPLAY_LIMITS.objects, "OBJECT_LIMIT");
    const retainedRefs: RetainedReplayRef[] = [];
    if (evidenceMode === "references") {
      const hashes = new Map<
        string,
        { payload_hash: string; recorded_at: string }
      >();
      for (const d of decisions)
        for (const r of d.decision.input_refs) {
          const old = hashes.get(r.object_id);
          requireReplay(
            !old ||
              (old.payload_hash === r.payload_hash &&
                old.recorded_at === r.recorded_at),
            "REFERENCE_COLLISION",
          );
          hashes.set(r.object_id, r);
        }
      for (const r of (
        await tx.query<{ object_id: string; recorded_at: Date }>(
          "SELECT object_id,recorded_at FROM btc_retention_objects WHERE object_id=ANY($1::text[]) ORDER BY object_id",
          [[...roots]],
        )
      ).rows) {
        const expected = hashes.get(r.object_id);
        requireReplay(
          !expected || expected.recorded_at === r.recorded_at.toISOString(),
          "REFERENCE_AS_OF",
        );
        retainedRefs.push({
          object_id: r.object_id,
          recorded_at: r.recorded_at.toISOString(),
          payload_hash: expected?.payload_hash ?? null,
        });
      }
      requireReplay(retainedRefs.length === roots.size, "DEPENDENCY_MISSING");
    }
    const evidence = new Map<string, ReplayEvidence>();
    let frontier = [
      ...(evidenceMode === "references" ? embedded : roots),
    ].sort();
    for (let depth = 0; frontier.length; depth++) {
      requireReplay(
        depth <= REPLAY_LIMITS.depth && Date.now() - started < 10000,
        "WORK_LIMIT",
      );
      requireReplay(
        evidence.size + frontier.length <= REPLAY_LIMITS.objects,
        "OBJECT_LIMIT",
      );
      const next = new Set<string>();
      for (let i = 0; i < frontier.length; i += 256) {
        requireReplay(Date.now() < budget.deadline, "WORK_LIMIT");
        const ids = frontier.slice(i, i + 256);
        const result = await tx.query<{
          object_id: string;
          bytes: number;
          value: Omit<ReplayEvidence, "payload_hash"> | null;
        }>(
          `SELECT object_id,octet_length(row_to_json(b)::text) bytes,
          CASE WHEN sum(octet_length(row_to_json(b)::text)) OVER ()<=$2 THEN row_to_json(b) ELSE NULL END value
          FROM (SELECT object_id,class,identity,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') recorded_at,payload,dependencies
          FROM btc_retention_objects WHERE object_id=ANY($1::text[])) b`,
          [ids, REPLAY_LIMITS.bytes - budget.bytes],
        );
        requireReplay(result.rows.length === ids.length, "DEPENDENCY_MISSING");
        for (const r of result.rows) {
          budget.bytes += r.bytes;
          requireReplay(
            r.value && budget.bytes <= REPLAY_LIMITS.bytes,
            "BYTE_LIMIT",
          );
          evidence.set(r.object_id, {
            ...r.value,
            payload_hash: replayHash(r.value.payload),
          });
          for (const id of r.value.dependencies)
            if (evidenceMode === "embedded" && !evidence.has(id)) next.add(id);
        }
      }
      frontier = [...next].filter((id) => !evidence.has(id)).sort();
    }
    const artifact = sealReplayDataset({
      schema_version: REPLAY_VERSION,
      code_sha: codeSha,
      contracts: REPLAY_CONTRACTS,
      cut: {
        captured_at: at,
        ledger_sequence: ledger.at(-1)?.sequence ?? "0",
        reservation_sequence: reservations.at(-1)?.sequence ?? "0",
        semantics: "locked_account_snapshot",
      },
      decision_selection: decisionIds
        ? { mode: "ids", ids: [...decisionIds].sort() }
        : { mode: "all" },
      evidence_mode: evidenceMode,
      retained_refs: retainedRefs,
      identity: rows[0].identity,
      ledger,
      reservations,
      decisions,
      jev,
      roots: [...roots].sort(),
      evidence: [...evidence.values()].sort((a, b) =>
        a.object_id.localeCompare(b.object_id),
      ),
    });
    replayDataset(artifact);
    requireReplay(Date.now() - started < 10000, "WORK_LIMIT");
    // Do not use the essential-evidence exemption to bypass finite worker budgets.
    const capacity = (
      await tx.query<{
        total: string;
        physical: string;
      }>(`SELECT total_bytes::text total,
      (pg_total_relation_size('btc_retention_objects')+pg_total_relation_size('btc_retention_dependencies')+pg_total_relation_size('btc_retention_pins')+pg_total_relation_size('btc_market_records')+pg_total_relation_size('btc_market_bars')+pg_total_relation_size('btc_market_head'))::text physical
      FROM btc_retention_policy WHERE dataset_id='btc-paper-v1'`)
    ).rows[0];
    const reserve = BigInt(REPLAY_LIMITS.bytes * 2);
    requireReplay(
      capacity &&
        BigInt(capacity.total) + reserve < 6n * 1024n ** 3n &&
        BigInt(capacity.physical) + reserve < 4n * 1024n ** 3n,
      "CAPACITY",
    );
    await storeRetentionObjectTx(tx, {
      id: artifact.dataset_id,
      class: "experiment",
      identity: ledgerScope(rows[0].identity),
      recordedAt: new Date(at),
      payload: artifact,
      dependencies: artifact.dataset.roots,
    });
    await pinRetentionObjectTx(
      tx,
      artifact.dataset_id,
      artifact.dataset_id,
      REPLAY_VERSION,
    );
    return artifact;
  });
}
export async function loadReplayDataset(
  pool: Pick<DatabasePool, "readOnly">,
  id: string,
) {
  requireReplay(/^btc-replay:[a-f0-9]{64}$/.test(id), "DATASET_ID");
  return pool.readOnly(5000, async (tx) => {
    const r = (
      await tx.query<{ payload: ReplayArtifact }>(
        "SELECT payload FROM btc_retention_objects WHERE object_id=$1 AND octet_length(payload::text)<=$2",
        [id, REPLAY_LIMITS.bytes * 2],
      )
    ).rows[0];
    requireReplay(
      r && r.payload.dataset_id === id,
      "DATASET_MISSING_OR_OVERSIZE",
    );
    replayDataset(r.payload);
    return r.payload;
  });
}

/** Resolve one declared root/input, never a provider call or unbounded export.
 * References with a producer hash must match; other immutable dependency roots
 * disclose their freshly computed digest without pretending it was captured. */
export async function loadReplayEvidence(
  pool: Pick<DatabasePool, "readOnly">,
  datasetId: string,
  objectId: string,
) {
  const a = await loadReplayDataset(pool, datasetId);
  const ref = a.dataset.retained_refs?.find((r) => r.object_id === objectId);
  const embedded = a.dataset.evidence.find((r) => r.object_id === objectId);
  requireReplay(ref || embedded, "EVIDENCE_NOT_DECLARED");
  return pool.readOnly(5000, async (tx) => {
    const row = (
      await tx.query<{
        recorded_at: Date;
        payload: unknown;
        dependencies: string[];
      }>(
        "SELECT recorded_at,payload,dependencies FROM btc_retention_objects WHERE object_id=$1 AND octet_length(jsonb_build_object('payload',payload,'dependencies',dependencies)::text)<=$2",
        [objectId, REPLAY_LIMITS.bytes - 1024],
      )
    ).rows[0];
    requireReplay(row, "EVIDENCE_MISSING_OR_OVERSIZE");
    const hash = replayHash(row.payload),
      expected = ref ?? embedded!;
    requireReplay(
      expected.recorded_at === row.recorded_at.toISOString() &&
        (expected.payload_hash === null || expected.payload_hash === hash),
      "EVIDENCE_HASH_OR_TIME",
    );
    return {
      object_id: objectId,
      recorded_at: row.recorded_at.toISOString(),
      payload_hash: hash,
      producer_hash_verified: expected.payload_hash !== null,
      payload: row.payload,
      dependencies: row.dependencies,
    };
  });
}
