import { createHash } from "node:crypto";

import {
  identity,
  command,
  fill,
  funding,
  usd,
  iso,
  start,
} from "./ledger-fixture.js";
import { fixture as baselineFixture } from "./baseline-fixture.js";
import { decideBaseline } from "../../src/storage/baseline-policy.js";
import {
  genesisBatch,
  materializeLedgerBatch,
} from "../../src/storage/ledger-contract.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { canonicalFingerprint } from "../../src/trading/replay.js";
import {
  replayHash,
  REPLAY_PAGED_VERSION,
  REPLAY_EQUITY_CONTRACTS,
  type ReplayDataset,
} from "../../src/storage/replay-dataset.js";
export function windowFixture(slots = 8640) {
  const id = identity("baseline"),
    scope = ledgerScope(id);
  const d: ReplayDataset = {
    schema_version: REPLAY_PAGED_VERSION,
    contracts: { ...REPLAY_EQUITY_CONTRACTS, replay: REPLAY_PAGED_VERSION },
    code_sha: "a".repeat(40),
    window: { start_at: iso(start), end_at: iso(start + slots * 300000) },
    cut: {
      captured_at: iso(start + slots * 300000),
      ledger_sequence: "1",
      reservation_sequence: "0",
      semantics: "locked_account_snapshot",
    },
    identity: id,
    ledger: materializeLedgerBatch(genesisBatch(id), "0", iso(start)),
    reservations: [],
    decisions: [],
    jev: [],
    roots: [],
    evidence: [],
    retained_refs: [],
    evidence_mode: "references",
    equity_history: {
      schema_version: "btc.replay-equity.v1",
      observation_ids: [],
    },
  };
  const hash = createHash("sha256").update(
    "[" + canonicalFingerprint(d.ledger[0]),
  );
  const append = (
    p: Parameters<typeof command>[1],
    at: number,
    economic = at,
  ) => {
    const key = `event:${d.ledger.length}`;
    const e = materializeLedgerBatch(
      { transaction_id: key, events: [command(key, p, scope, economic)] },
      String(d.ledger.length),
      iso(at),
    )[0]!;
    d.ledger.push(e);
    hash.update("," + canonicalFingerprint(e));
  };
  const add = (object_id: string, payload: unknown, at: number) => {
    d.roots.push(object_id);
    d.evidence.push({
      object_id,
      class: "financial",
      identity: scope,
      recorded_at: iso(at),
      payload,
      payload_hash: replayHash(payload),
      dependencies: [],
    });
  };
  let flows = 0n;
  for (let i = 0; i <= slots; i++) {
    const at = start + i * 300000;
    if (i === 1) {
      append(fill(), at - 3);
      append(
        {
          ...fill("close", "sell"),
          price: { raw: "65000000000", unit: "USD_PER_BTC", decimals: 6 },
        } as Parameters<typeof command>[1],
        at - 2,
      );
      append(
        { event_type: "fee", execution_id: "exec:1", delta: usd("-100000") },
        at - 1,
      );
    }
    if (i > 0 && i <= 6000) {
      append(
        { event_type: "cash", reason: "transfer", delta: usd("1000000") },
        at,
      );
      flows += 1000000n;
    }
    if (i === Math.floor(slots / 2))
      append(funding("-100000000"), at, start + 1000);
    const pnl = i === 0 ? 0n : 10000000n,
      fee = i === 0 ? 0n : -100000n,
      fu = i < Math.floor(slots / 2) ? 0n : -100000000n;
    const balance = 1000000000n + flows + pnl + fee + fu,
      oid = `observation:${i}`;
    add(
      oid,
      {
        schema_version: "btc.equity-observation.v1",
        scope,
        observed_at: iso(at),
        slot: iso(at),
        financial_start_at: iso(start),
        ledger: {
          last_sequence: String(d.ledger.length),
          hash: hash.copy().update("]").digest("hex"),
        },
        reservations: {
          last_sequence: "0",
          hash: replayHash([]),
          held_usd_raw: "0",
        },
        capital_usd_raw: "1000000000",
        external_flows_usd_raw: String(flows),
        realized_pnl_usd_raw: String(pnl),
        fees_usd_raw: String(fee),
        funding_usd_raw: String(fu),
        balance_usd_raw: String(balance),
        equity_usd_raw: String(balance),
        unrealized_pnl_usd_raw: "0",
        mark: { evidence: null },
        capture_evidence_id: null,
      },
      at,
    );
    d.equity_history!.observation_ids.push(oid);
    if (i > 0 && i % 3 === 0) {
      const original = decideBaseline(baselineFixture());
      const decision = {
        ...original,
        signal: null,
        candidate: null,
        intent: null,
        command: null,
        state: "data_unavailable" as const,
        reasons: ["fixture_missing_source"],
        decision_id: replayHash({ fixture: i }),
        decision_at: iso(at),
        bar_end_at: iso(at),
        input_refs: [],
      };
      const evidence_id = `decision:${decision.decision_id}`;
      d.decisions.push({ decision, evidence_id });
      add(evidence_id, decision, at);
    }
  }
  d.cut.ledger_sequence = String(d.ledger.length);
  return d;
}
