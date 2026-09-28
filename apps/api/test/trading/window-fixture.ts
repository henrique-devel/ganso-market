import { parseTradingAmount } from "@ganso-market/contracts/trading";

import { identity, iso, start, command } from "./ledger-fixture.js";
import { market, pricedFill } from "./valuation-fixture.js";
import {
  genesisBatch,
  materializeLedgerBatch,
  type LedgerPayload,
} from "../../src/storage/ledger-contract.js";
import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import {
  projectFinancials,
  valueFinancials,
} from "../../src/trading/valuation.js";
import {
  REPLAY_EQUITY_CONTRACTS,
  REPLAY_EQUITY_VERSION,
  replayHash,
  sealReplayDataset,
  type ReplayDataset,
} from "../../src/storage/replay-dataset.js";
import { accountMetrics } from "../../src/storage/metrics.js";

export function windowAccount(id = identity(), open = false) {
  const d: ReplayDataset = {
    schema_version: REPLAY_EQUITY_VERSION,
    contracts: REPLAY_EQUITY_CONTRACTS,
    equity_history: {
      schema_version: "btc.replay-equity.v1",
      observation_ids: [],
    },
    code_sha: "a".repeat(40),
    cut: {
      captured_at: iso(start + 1000),
      ledger_sequence: "1",
      reservation_sequence: "0",
      semantics: "locked_account_snapshot",
    },
    identity: id,
    ledger: materializeLedgerBatch(
      genesisBatch(id),
      "0",
      id.experiment.started_at,
    ),
    reservations: [],
    decisions: [],
    jev: [],
    roots: [],
    evidence: [],
  };
  const append = (p: LedgerPayload, at: number, economic = at) => {
    const key = `event:${d.ledger.length}`;
    d.ledger.push(
      ...materializeLedgerBatch(
        {
          transaction_id: key,
          events: [command(key, p, ledgerScope(id), economic)],
        },
        String(d.ledger.length),
        iso(at),
      ),
    );
    d.cut.ledger_sequence = String(d.ledger.length);
  };
  if (open) append(pricedFill("open", "buy"), start + 1000);
  const sample = (offset: number, price: string, gap = false) => {
    const at = start + offset,
      m = market(at),
      key = `sample:${offset}`;
    if (m.context!.payload.payload.kind !== "mark_funding")
      throw new Error("fixture");
    m.context!.payload = {
      ...m.context!.payload,
      payload: {
        ...m.context!.payload.payload,
        mark_price: parseTradingAmount("USD_PER_BTC", {
          ...m.context!.payload.payload.mark_price,
          raw: price,
        }),
      },
    };
    m.context!.object_id = `${key}:mark`;
    if (gap) m.capture!.health.channels.context.needs_revalidation = true;
    const v = valueFinancials(
      projectFinancials(replayLedger(id, d.ledger), d.ledger),
      m,
    );
    let flows = 0n;
    for (const e of d.ledger)
      if (
        e.payload.event_type === "cash" &&
        e.payload.reason !== "initial_allocation"
      )
        flows += BigInt(e.payload.delta.raw);
    const add = (
      object_id: string,
      payload: unknown,
      dependencies: string[] = [],
    ) => {
      d.roots.push(object_id);
      d.evidence.push({
        object_id,
        payload,
        payload_hash: replayHash(payload),
        dependencies,
        identity: ledgerScope(id),
        recorded_at: iso(at),
        class: "financial",
      });
    };
    add(m.context!.object_id, m.context!.payload);
    add(`${key}:capture`, m.capture);
    add(
      key,
      {
        schema_version: "btc.equity-observation.v1",
        scope: ledgerScope(id),
        observed_at: iso(at),
        slot: iso(Math.floor(at / 300000) * 300000),
        financial_start_at: id.experiment.started_at,
        ledger: {
          last_sequence: d.cut.ledger_sequence,
          hash: replayHash(d.ledger),
        },
        reservations: {
          last_sequence: "0",
          hash: replayHash([]),
          held_usd_raw: "0",
        },
        capital_usd_raw: "1000000000",
        external_flows_usd_raw: flows.toString(),
        realized_pnl_usd_raw: v.realized_pnl_usd_raw,
        fees_usd_raw: v.fees_usd_raw,
        funding_usd_raw: v.funding_usd_raw,
        balance_usd_raw: v.balance_usd_raw,
        equity_usd_raw: v.maintenance.equity_usd_raw,
        unrealized_pnl_usd_raw: v.maintenance.unrealized_pnl_usd_raw,
        mark: { evidence: m.context!.object_id },
        capture_evidence_id: `${key}:capture`,
      },
      [m.context!.object_id, `${key}:capture`],
    );
    d.equity_history!.observation_ids.push(key);
    d.cut.captured_at = iso(at + 1000);
  };
  return {
    d,
    append,
    sample,
    report: () => accountMetrics(sealReplayDataset(d)),
  };
}
