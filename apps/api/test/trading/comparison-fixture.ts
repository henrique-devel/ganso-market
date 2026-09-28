import { identity, iso, start } from "./ledger-fixture.js";
import { windowAccount } from "./window-fixture.js";
import { fixture } from "./baseline-fixture.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import {
  baselineHash,
  type BaselineRegistration,
} from "../../src/storage/baseline-inputs.js";
import {
  replayHash,
  sealReplayDataset,
  type ReplayDataset,
} from "../../src/storage/replay-dataset.js";
import {
  compareWindowArtifacts,
  type WindowComparison,
} from "../../src/storage/window-metrics.js";
import type { ComparisonWindow } from "../../src/storage/comparison-window.js";
import type { CostAllocation } from "../../src/trading/metrics.js";
export function pair(open = false) {
  const a = windowAccount(identity("baseline"), open),
    id = identity("challenger");
  Object.assign(id.experiment, { started_at: iso(start + 900000) });
  const b = windowAccount(id);
  const source: BaselineRegistration = {
    ...fixture().registration,
    scope: ledgerScope(a.d.identity),
    registered_at: iso(start - 1000),
    start_at: iso(start),
    code_sha: "b".repeat(40),
  };
  const registration: BaselineRegistration = {
    ...source,
    schema_version: "btc.baseline-registration.v2",
    scope: ledgerScope(b.d.identity),
    registered_at: iso(start + 100),
    start_at: id.experiment.started_at,
    code_sha: "c".repeat(40),
  };
  const w: ComparisonWindow = {
    version: "btc.comparison-window.v1",
    start_at: registration.start_at,
    end_at: iso(start + 1800000),
    purpose: "operational_pilot",
    registered_at: registration.registered_at,
    source_evidence_id: "source",
    source_period_evidence_id: "source",
    source_period: null,
    source_registration_hash: baselineHash(source),
    source_code_sha: source.code_sha,
    challenger_code_sha: registration.code_sha,
    source_manifest: source.manifest_fingerprint,
    challenger_manifest: registration.manifest_fingerprint,
    source_policy: source.policy_version,
    challenger_policy: registration.policy_version,
  };
  const add = (
    d: ReplayDataset,
    object_id: string,
    payload: unknown,
    recorded_at: string,
    dependencies: string[] = [],
  ) => {
    d.roots.push(object_id);
    d.evidence.push({
      object_id,
      payload,
      recorded_at,
      dependencies,
      payload_hash: replayHash(payload),
      identity: ledgerScope(d.identity),
      class: "experiment",
    });
  };
  const seal = () => {
    b.d.roots = b.d.roots.filter(
      (id) => !["source", "registration"].includes(id),
    );
    b.d.evidence = b.d.evidence.filter(
      (o) => !["source", "registration"].includes(o.object_id),
    );
    add(b.d, "source", { registration: source }, source.registered_at);
    add(
      b.d,
      "registration",
      {
        registration,
        challenger: {
          version: "btc.jev-comparison.v2",
          evaluation: w,
          source_account: "baseline",
          source_start_at: source.start_at,
          source_registration_hash: baselineHash(source),
          comparison_start_at: w.start_at,
        },
      },
      w.registered_at,
      ["source"],
    );
    a.d.cut.captured_at = b.d.cut.captured_at = iso(start + 1801000);
    const x = sealReplayDataset(a.d),
      y = sealReplayDataset(b.d);
    const c: WindowComparison = {
      schema_version: "btc.economic-comparison.v2",
      baseline_dataset_id: x.dataset_id,
      challenger_dataset_id: y.dataset_id,
      registration_evidence_id: "registration",
      market_dataset_hash: "sha256:" + "a".repeat(64),
      baseline_risk_hash: "sha256:" + "b".repeat(64),
      challenger_risk_hash: "sha256:" + "b".repeat(64),
      declared_version_differences: ["code_sha"],
    };
    return { x, y, c };
  };
  return {
    a,
    b,
    w,
    source,
    registration,
    seal,
    report: (cost?: CostAllocation) => {
      const { x, y, c } = seal();
      return compareWindowArtifacts(x, y, c, cost);
    },
  };
}
