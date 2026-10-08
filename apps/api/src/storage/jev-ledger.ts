import {
  assertJevOwnership,
  jevEventKey,
  parseJevContract,
  parseJevLedgerEvent,
  parseTradingContract,
  requireJev,
  JEV_VERSION,
  type JevAccount,
  type JevBinding,
  type JevLedgerEvent,
  type JevProfile,
  type JevScope,
  type TradingInstrument,
} from "@ganso-market/contracts/trading";
import {
  createLedgerReducer,
  type LedgerReplayEvent,
} from "../trading/ledger.js";
import { canonicalFingerprint } from "../trading/replay.js";

export const JEV_LEDGER_VERSION = "btc.jev-ledger.v2" as const;
export interface JevLedgerIdentity {
  account: JevAccount;
  instrument: TradingInstrument;
  bindings: { binding: JevBinding; profile: JevProfile }[];
}
export type JevLedgerCommand = Omit<
  JevLedgerEvent,
  "sequence" | "transaction_id" | "recorded_at"
>;
export interface JevLedgerBatch {
  transaction_id: string;
  events: JevLedgerCommand[];
}
export const jevScope = (
  b: JevBinding,
  instrument: TradingInstrument,
): JevScope => ({
  schema_version: JEV_VERSION,
  owner_id: b.owner_id,
  mode: b.mode,
  account_id: b.account_id,
  profile_id: b.profile_id,
  profile_version: b.profile_version,
  experiment_id: b.experiment_id,
  instrument_id: instrument.instrument_id,
  instrument_version: instrument.instrument_version,
});
export function validateJevLedgerIdentity(identity: JevLedgerIdentity) {
  parseJevContract("account", identity.account);
  parseTradingContract("instrument", identity.instrument);
  requireJev(
    identity.instrument.instrument_id === "hyperliquid:mainnet:BTC" &&
      identity.instrument.origin.received_at <= identity.account.started_at &&
      identity.bindings.length > 0 &&
      identity.bindings.length <= 4096,
    "LEDGER_IDENTITY",
  );
  const ids = new Set<string>();
  for (const { binding, profile } of identity.bindings) {
    assertJevOwnership(
      jevScope(binding, identity.instrument),
      binding,
      identity.account,
      profile,
    );
    requireJev(!ids.has(binding.experiment_id), "DUPLICATE_BINDING");
    ids.add(binding.experiment_id);
  }
}
export function jevGenesis(identity: JevLedgerIdentity): JevLedgerBatch {
  validateJevLedgerIdentity(identity);
  requireJev(
    identity.account.mode !== "live",
    "LIVE_FUNDING_REQUIRES_VENUE_EVIDENCE",
  );
  const initial = identity.bindings[0]!.binding;
  const scope = jevScope(initial, identity.instrument);
  return {
    transaction_id: "genesis",
    events: [
      {
        ...scope,
        event_id: "genesis",
        idempotency_key: jevEventKey(scope, "genesis"),
        cause_id: initial.experiment_id,
        occurred_at: identity.account
          .started_at as JevLedgerEvent["occurred_at"],
        payload: {
          event_type: "cash",
          reason: "initial_allocation",
          delta: identity.account.initial_allocation,
        },
      },
    ],
  };
}
export function materializeJevBatch(
  batch: JevLedgerBatch,
  previous: string,
  recordedAt: string,
): JevLedgerEvent[] {
  requireJev(
    Object.keys(batch).sort().join() === "events,transaction_id" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(batch.transaction_id) &&
      /^(0|[1-9][0-9]*)$/.test(previous) &&
      batch.events.length > 0 &&
      batch.events.length <= 128 &&
      canonicalFingerprint(batch).length <= 1048576,
    "BATCH",
  );
  return batch.events.map((command, index) => {
    requireJev(
      !["sequence", "recorded_at", "transaction_id"].some((k) =>
        Object.hasOwn(command, k),
      ),
      "STORE_FIELDS",
    );
    return parseJevLedgerEvent({
      ...command,
      sequence: String(
        BigInt(previous) + BigInt(index) + 1n,
      ) as JevLedgerEvent["sequence"],
      transaction_id: batch.transaction_id,
      recorded_at: recordedAt as JevLedgerEvent["recorded_at"],
    });
  });
}
/** Full financial history is always reduced. A reporting window never creates a new genesis. */
export function replayJevLedger(
  identity: JevLedgerIdentity,
  input: readonly JevLedgerEvent[],
  window?: { start_at: string; end_at: string },
) {
  validateJevLedgerIdentity(identity);
  if (window)
    requireJev(
      [window.start_at, window.end_at].every(
        (s) =>
          Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
      ) && window.start_at < window.end_at,
      "WINDOW",
    );
  const account = identity.account;
  const ordered = [...input].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence)
      ? -1
      : BigInt(a.sequence) > BigInt(b.sequence)
        ? 1
        : 0,
  );
  // Live reserves a durable identity only in JE02. No fictitious cash entry is legal.
  requireJev(
    account.mode !== "live" || ordered.length === 0,
    "LIVE_FUNDING_REQUIRES_VENUE_EVIDENCE",
  );
  const lifetimeExperiment = `financial:${account.account_id}`;
  const economicIdentity = {
    account: {
      mode: "paper" as const,
      account_id: account.account_id,
      experiment_id: lifetimeExperiment,
    },
    experiment: {
      experiment_id: lifetimeExperiment,
      started_at: account.started_at,
    },
    instrument: identity.instrument,
  };
  // Only the economic arithmetic is shared with v1; stored ownership is never normalized.
  const reducer = createLedgerReducer(
    economicIdentity,
    account.initial_allocation.raw,
  );
  const executions = new Map<string, JevScope>();
  const positions = new Map<string, JevScope>();
  for (const event of ordered) {
    parseJevLedgerEvent(event);
    const pair = identity.bindings.find(
      (x) => x.binding.experiment_id === event.experiment_id,
    );
    requireJev(
      pair && event.occurred_at >= pair.binding.started_at,
      "EVENT_BINDING",
    );
    assertJevOwnership(
      event,
      pair.binding,
      account,
      pair.profile,
      jevScope(pair.binding, identity.instrument),
    );
    const p = event.payload;
    requireJev(
      p.event_type !== "cash" ||
        (event.sequence === "1" && p.reason === "initial_allocation"),
      "NO_CAPITAL_RESET_OR_TRANSFER",
    );
    if (p.event_type === "cash")
      requireJev(
        event.cause_id === pair.binding.experiment_id &&
          event.occurred_at === pair.binding.started_at &&
          pair.binding.started_at === account.started_at,
        "GENESIS_IDENTITY",
      );
    if (p.event_type === "fill") {
      const owner = positions.get(p.position_id);
      if (owner)
        assertJevOwnership(event, pair.binding, account, pair.profile, owner);
      positions.set(p.position_id, jevScope(pair.binding, identity.instrument));
      executions.set(
        p.execution_id,
        jevScope(pair.binding, identity.instrument),
      );
    } else if (p.event_type === "fee" || p.event_type === "liquidation") {
      const parent = executions.get(p.execution_id);
      requireJev(parent, "EXECUTION_OWNER");
      assertJevOwnership(event, pair.binding, account, pair.profile, parent);
    } else if (p.event_type === "funding") {
      const parent = positions.get(p.position_id);
      requireJev(parent, "POSITION_OWNER");
      assertJevOwnership(event, pair.binding, account, pair.profile, parent);
    }
    reducer.append({
      ...event,
      mode: "paper",
      experiment_id: lifetimeExperiment,
      cause_id:
        event.event_id === "genesis" ? lifetimeExperiment : event.cause_id,
    } as LedgerReplayEvent);
  }
  const projection =
    account.mode === "live"
      ? { last_sequence: "0", cash_usd_raw: "0", positions: [] }
      : reducer.snapshot();
  return {
    schema_version: JEV_LEDGER_VERSION,
    owner_id: account.owner_id,
    account_id: account.account_id,
    mode: account.mode,
    last_sequence: projection.last_sequence,
    cash_usd_raw: projection.cash_usd_raw,
    positions: projection.positions,
    window_event_ids: ordered
      .filter(
        (e) =>
          !window ||
          (e.occurred_at >= window.start_at && e.occurred_at < window.end_at),
      )
      .map((e) => e.event_id),
  };
}
