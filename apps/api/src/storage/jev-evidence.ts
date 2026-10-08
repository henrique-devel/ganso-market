import {
  parseJevContract,
  requireJev,
  type JevScope,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { assertEvidenceJson } from "../trading/retention.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { jevTime } from "./jev-context.js";
import { jevHash } from "./jev-hash.js";

export const JEV_EVIDENCE_POLICY = Object.freeze({
  version: "jev-evidence-v1",
  schema: "jev.evidence.v1",
  postCloseDays: 180,
  maxBatch: 500,
});
const kinds = [
  "inputs",
  "context",
  "response",
  "decision",
  "order",
  "fill",
  "funding",
  "quality",
  "cost",
  "proposal",
  "ledger",
  "result",
  "version",
] as const;
export type JevEvidenceKind = (typeof kinds)[number];
export interface JevEvidence {
  schema_version: "jev.evidence.v1";
  object_id: string;
  scope: JevScope;
  kind: JevEvidenceKind;
  recorded_at: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  dependencies: string[];
  sources: string[];
}
const id = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 512;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** Exact original artifacts, selected inputs and explicit graph edges. No raw feed archive or inference. */
export function validateJevEvidence(e: JevEvidence) {
  assertEvidenceJson(e);
  requireJev(
    e.schema_version === JEV_EVIDENCE_POLICY.schema &&
      kinds.includes(e.kind) &&
      id(e.object_id),
    "EVIDENCE_ENVELOPE",
  );
  const { instrument_id, instrument_version, ...binding } = e.scope;
  parseJevContract("binding", { ...binding, started_at: e.recorded_at });
  requireJev(
    instrument_id === "hyperliquid:mainnet:BTC" && id(instrument_version),
    "EVIDENCE_INSTRUMENT",
  );
  jevTime(e.recorded_at);
  requireJev(
    object(e.payload) && jevHash(e.payload) === e.payload_hash,
    "EVIDENCE_HASH",
  );
  for (const edges of [e.dependencies, e.sources])
    requireJev(
      Array.isArray(edges) &&
        edges.length <= 65536 &&
        new Set(edges).size === edges.length &&
        edges.every((x) => id(x) && x !== e.object_id),
      "EVIDENCE_EDGES",
    );
  const p = e.payload;
  const dependency = (v: unknown) =>
    requireJev(id(v) && e.dependencies.includes(v), "EVIDENCE_REQUIRED_EDGE");
  if (e.kind === "inputs") {
    requireJev(
      Array.isArray(p.records) &&
        p.records.length > 0 &&
        p.records.length <= 65536,
      "EVIDENCE_INPUTS",
    );
    const seen = new Set<string>();
    for (const r of p.records) {
      requireJev(
        object(r) &&
          id(r.object_id) &&
          !seen.has(r.object_id) &&
          r.payload_hash === jevHash(r.payload),
        "EVIDENCE_INPUT_HASH",
      );
      seen.add(r.object_id);
      requireJev(
        jevTime(String(r.recorded_at)) <= jevTime(e.recorded_at) &&
          jevTime(String(r.received_at)) <= jevTime(e.recorded_at),
        "EVIDENCE_FUTURE_INPUT",
      );
    }
  } else if (e.kind === "context") {
    requireJev(
      object(p.context) &&
        p.context.schema_version === "btc.jev-context.v1" &&
        jevHash(p.context.scope) === jevHash(e.scope),
      "EVIDENCE_CONTEXT",
    );
    dependency(p.input_bundle_id);
  } else if (e.kind === "response") {
    requireJev(
      id(p.request_id) &&
        typeof p.model === "string" &&
        p.model.length > 0 &&
        ["received", "timeout", "transport_error"].includes(
          String(p.outcome),
        ) &&
        (typeof p.original_body === "string" || p.original_body === null),
      "EVIDENCE_RESPONSE",
    );
    requireJev(
      p.outcome !== "received" || typeof p.original_body === "string",
      "EVIDENCE_RESPONSE_BODY",
    );
    if (p.participants !== undefined) {
      requireJev(
        Array.isArray(p.participants) &&
          p.participants.length >= 1 &&
          p.participants.length <= 3,
        "EVIDENCE_PARTICIPANTS",
      );
      for (const scope of p.participants) {
        requireJev(
          object(scope) &&
            scope.owner_id === e.scope.owner_id &&
            scope.profile_id === e.scope.profile_id &&
            scope.profile_version === e.scope.profile_version &&
            scope.instrument_id === e.scope.instrument_id &&
            scope.instrument_version === e.scope.instrument_version,
          "EVIDENCE_BATCH_SCOPE",
        );
        const {
          instrument_id: _id,
          instrument_version: _version,
          ...binding
        } = scope;
        parseJevContract("binding", { ...binding, started_at: e.recorded_at });
      }
      requireJev(
        p.participants.some((s) => jevHash(s) === jevHash(e.scope)) &&
          new Set(p.participants.map(jevHash)).size === p.participants.length,
        "EVIDENCE_PARTICIPANTS",
      );
    }
  } else if (e.kind === "decision") {
    requireJev(
      id(p.request_id) &&
        ["hold", "open", "close"].includes(String(p.action)) &&
        object(p.question) &&
        object(p.original_decision),
      "EVIDENCE_DECISION",
    );
    dependency(p.context_id);
    dependency(p.response_id);
  } else if (e.kind === "quality") {
    requireJev(
      jevTime(String(p.start_at)) <= jevTime(String(p.end_at)) &&
        jevTime(String(p.end_at)) <= jevTime(e.recorded_at) &&
        Array.isArray(p.gaps) &&
        object(p.counters),
      "EVIDENCE_QUALITY",
    );
  } else {
    // Original venue/ledger/cost/proposal artifacts remain lossless JSON. Their economic validators belong to their own writers.
    requireJev(id(p.artifact_id) && object(p.original), "EVIDENCE_ARTIFACT");
  }
}
export function makeJevEvidence(
  input: Omit<JevEvidence, "schema_version" | "payload_hash">,
): JevEvidence {
  const e: JevEvidence = {
    ...structuredClone(input),
    schema_version: "jev.evidence.v1",
    payload_hash: jevHash(input.payload),
  };
  validateJevEvidence(e);
  return e;
}
type Store = Pick<DatabasePool, "transaction">;
/** Caller must hold withBtcRetentionTransaction; never pass a pool as tx.
 * Future runtime writers can then persist the whole decision/response graph atomically. */
export async function storeJevEvidenceTx(tx: SqlExecutor, e: JevEvidence) {
  validateJevEvidence(e);
  const prior = (
    await tx.query(
      "SELECT envelope,charged_bytes::text FROM jev_evidence_objects WHERE object_id=$1",
      [e.object_id],
    )
  ).rows[0];
  if (prior) {
    requireJev(
      jevHash(prior.envelope) === jevHash(e),
      "EVIDENCE_IDEMPOTENCY_COLLISION",
    );
    return {
      status: "duplicate" as const,
      charged_bytes: prior.charged_bytes as string,
    };
  }
  if (e.kind === "response" && Array.isArray(e.payload.participants)) {
    for (const scope of e.payload.participants as JevScope[]) {
      const b = (
        await tx.query(
          "SELECT b.binding,a.instrument_id,a.instrument_version FROM jev_bindings b JOIN jev_accounts a USING(account_id) WHERE b.experiment_id=$1",
          [scope.experiment_id],
        )
      ).rows[0];
      requireJev(b, "EVIDENCE_BATCH_BINDING");
      const { started_at: _start, ...binding } = b.binding as Record<
        string,
        unknown
      >;
      requireJev(
        jevHash({
          ...binding,
          instrument_id: b.instrument_id,
          instrument_version: b.instrument_version,
        }) === jevHash(scope),
        "EVIDENCE_BATCH_BINDING",
      );
    }
  }
  if (e.kind === "context" || e.kind === "decision") {
    const deps = (
      await tx.query(
        "SELECT object_id,kind,envelope FROM jev_evidence_objects WHERE object_id=ANY($1::text[])",
        [e.dependencies],
      )
    ).rows;
    const get = (key: string, kind: string, shared = false) => {
      const row = deps.find(
        (r) => r.object_id === e.payload[key] && r.kind === kind,
      );
      const original = row?.envelope as JevEvidence | undefined;
      requireJev(
        original &&
          (jevHash(original.scope) === jevHash(e.scope) ||
            (shared &&
              Array.isArray(original.payload.participants) &&
              original.payload.participants.some(
                (s) => jevHash(s) === jevHash(e.scope),
              ))),
        "EVIDENCE_REQUIRED_DEPENDENCY",
      );
      return original;
    };
    if (e.kind === "context") {
      const inputs = get("input_bundle_id", "inputs");
      const refs = (e.payload.context as Record<string, unknown>).input_refs;
      requireJev(Array.isArray(refs), "EVIDENCE_CONTEXT_REFS");
      const records = inputs.payload.records as Record<string, unknown>[];
      for (const ref of refs) {
        requireJev(
          object(ref) &&
            records.some(
              (r) =>
                r.object_id === ref.object_id &&
                r.payload_hash === ref.payload_hash &&
                r.recorded_at === ref.recorded_at &&
                r.received_at === ref.received_at,
            ),
          "EVIDENCE_INCOMPLETE_INPUTS",
        );
      }
    } else {
      get("context_id", "context");
      const response = get("response_id", "response", true);
      requireJev(
        response.payload.request_id === e.payload.request_id &&
          response.payload.outcome === "received",
        "EVIDENCE_DECISION_RESPONSE",
      );
    }
  }
  const row = (
    await tx.query(
      "INSERT INTO jev_evidence_objects(object_id,experiment_id,kind,recorded_at,envelope,dependencies,sources,charged_bytes) VALUES($1,$2,$3,$4,$5::jsonb,$6::text[],$7::text[],1) RETURNING charged_bytes::text",
      [
        e.object_id,
        e.scope.experiment_id,
        e.kind,
        e.recorded_at,
        JSON.stringify(e),
        e.dependencies,
        e.sources,
      ],
    )
  ).rows[0]!;
  return {
    status: "stored" as const,
    charged_bytes: row.charged_bytes as string,
  };
}
export async function storeJevEvidence(
  pool: Store,
  input: readonly JevEvidence[],
) {
  requireJev(input.length > 0 && input.length <= 500, "EVIDENCE_BATCH");
  const batch = structuredClone(input);
  batch.forEach(validateJevEvidence);
  return withBtcRetentionTransaction(pool, async (tx) => {
    const out = [];
    for (const e of batch) out.push(await storeJevEvidenceTx(tx, e));
    return out;
  });
}
export async function closeJevEvidence(
  pool: Store,
  owner: string,
  experiment: string,
  closedAt: string,
  reason: string,
) {
  jevTime(closedAt);
  return withBtcRetentionTransaction(pool, async (tx) => {
    requireJev(
      (
        await tx.query(
          "SELECT 1 FROM jev_bindings WHERE owner_id=$1 AND experiment_id=$2",
          [owner, experiment],
        )
      ).rows.length,
      "EVIDENCE_OWNER",
    );
    const old = (
      await tx.query(
        "SELECT closed_at,reason FROM jev_evidence_closures WHERE experiment_id=$1",
        [experiment],
      )
    ).rows[0];
    if (old) {
      requireJev(
        new Date(old.closed_at as string).toISOString() === closedAt &&
          old.reason === reason,
        "EVIDENCE_CLOSURE_COLLISION",
      );
      return;
    }
    await tx.query("INSERT INTO jev_evidence_closures VALUES($1,$2,$3)", [
      experiment,
      closedAt,
      reason,
    ]);
  });
}
export async function pinJevEvidence(
  pool: Store,
  owner: string,
  pin: string,
  root: string,
  reason: string,
) {
  return withBtcRetentionTransaction(pool, async (tx) => {
    requireJev(
      (
        await tx.query(
          "SELECT 1 FROM jev_evidence_objects WHERE object_id=$1 AND envelope->'scope'->>'owner_id'=$2",
          [root, owner],
        )
      ).rows.length,
      "EVIDENCE_OWNER",
    );
    const old = (
      await tx.query(
        "SELECT object_id,reason FROM jev_evidence_pins WHERE pin_id=$1",
        [pin],
      )
    ).rows[0];
    if (old) {
      requireJev(
        old.object_id === root && old.reason === reason,
        "EVIDENCE_PIN_COLLISION",
      );
      return;
    }
    await tx.query("INSERT INTO jev_evidence_pins VALUES($1,$2,$3)", [
      pin,
      root,
      reason,
    ]);
  });
}
/** Read original answers and closure; replay never invokes the provider. */
export async function readJevEvidence(
  pool: Store,
  owner: string,
  root: string,
) {
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL statement_timeout='5s'");
    const rows = (
      await tx.query(
        `WITH RECURSIVE closure(object_id) AS (
      SELECT object_id FROM jev_evidence_objects WHERE object_id=$1 AND envelope->'scope'->>'owner_id'=$2
      UNION SELECT d.dependency_id FROM jev_evidence_dependencies d JOIN closure c USING(object_id)
    ) SELECT o.envelope FROM jev_evidence_objects o JOIN closure c USING(object_id) ORDER BY o.object_id`,
        [root, owner],
      )
    ).rows;
    requireJev(rows.length, "EVIDENCE_NOT_FOUND");
    const objects = rows.map((r) => r.envelope as JevEvidence);
    objects.forEach(validateJevEvidence);
    const sourceIds = [...new Set(objects.flatMap((e) => e.sources))];
    const sources = (
      await tx.query(
        `WITH RECURSIVE closure(object_id) AS (
      SELECT object_id FROM btc_retention_objects WHERE object_id=ANY($1::text[])
      UNION SELECT d.dependency_id FROM btc_retention_dependencies d JOIN closure c USING(object_id)
    ) SELECT o.object_id,o.identity,o.recorded_at,o.payload,o.dependencies FROM btc_retention_objects o JOIN closure c USING(object_id) ORDER BY o.object_id`,
        [sourceIds],
      )
    ).rows;
    requireJev(
      sourceIds.every((id) => sources.some((r) => r.object_id === id)),
      "EVIDENCE_MISSING_SOURCE",
    );
    return { objects, sources };
  });
}
/** Explicit bounded leaf pruning only; no boot hook/route/scheduler calls it. HOLD remains authoritative. */
export async function retainJevEvidence(
  pool: Store,
  options: { policy_version: string; limit: number; execute: boolean },
) {
  requireJev(
    options.policy_version === JEV_EVIDENCE_POLICY.version &&
      Number.isInteger(options.limit) &&
      options.limit >= 1 &&
      options.limit <= JEV_EVIDENCE_POLICY.maxBatch &&
      typeof options.execute === "boolean",
    "EVIDENCE_RETENTION_SCOPE",
  );
  return withBtcRetentionTransaction(pool, async (tx) => {
    const rows = (
      await tx.query(
        `SELECT o.object_id,o.charged_bytes::text FROM jev_evidence_objects o
      JOIN jev_evidence_closures c USING(experiment_id) CROSS JOIN btc_retention_policy p
      WHERE p.dataset_id='btc-paper-v1' AND NOT p.hold AND o.kind NOT IN ('ledger','result','version')
      AND ((c.closed_at AT TIME ZONE 'UTC')+interval '180 days') AT TIME ZONE 'UTC'<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM jev_evidence_pins WHERE object_id=o.object_id)
      AND NOT EXISTS(SELECT 1 FROM jev_evidence_dependencies WHERE dependency_id=o.object_id)
      ORDER BY c.closed_at,o.object_id LIMIT $1`,
        [options.limit],
      )
    ).rows;
    if (options.execute && rows.length) {
      await tx.query(
        "SELECT set_config('ganso.jev_retention_policy',$1,TRUE)",
        [options.policy_version],
      );
      await tx.query(
        "DELETE FROM jev_evidence_objects WHERE object_id=ANY($1::text[])",
        [rows.map((r) => r.object_id)],
      );
    }
    return { executed: options.execute, objects: rows };
  });
}
