/** Pure S1 reduction. Adapter validates complete trading.v1 contracts first.
 * Cash is USD at 6 decimals; signed position quantities are BTC at 8 decimals. */
export const LEDGER_VERSION = "btc.ledger.v1" as const;
export interface LedgerScope {
  readonly mode: "paper";
  readonly account_id: string;
  readonly experiment_id: string;
  readonly instrument_id: string;
  readonly instrument_version: string;
}
export interface LedgerIdentityInput {
  readonly account: {
    readonly mode: "paper";
    readonly account_id: string;
    readonly experiment_id: string;
  };
  readonly experiment: {
    readonly experiment_id: string;
    readonly started_at: string;
  };
  readonly instrument: {
    readonly instrument_id: string;
    readonly instrument_version: string;
    readonly quantity_step: { readonly raw: string };
    readonly tick_size: { readonly raw: string };
  };
}
export interface LedgerReplayEvent extends LedgerScope {
  readonly event_id: string;
  readonly sequence: string;
  readonly transaction_id: string;
  readonly cause_id: string;
  readonly occurred_at: string;
  readonly payload:
    | {
        readonly event_type: "cash";
        readonly reason: "initial_allocation" | "transfer";
        readonly delta: { readonly raw: string };
      }
    | {
        readonly event_type: "fill";
        readonly execution_id: string;
        readonly position_id: string;
        readonly side: "buy" | "sell";
        readonly quantity: { readonly raw: string };
        readonly price: { readonly raw: string };
      }
    | {
        readonly event_type: "fee";
        readonly execution_id: string;
        readonly delta: { readonly raw: string };
      }
    | {
        readonly event_type: "funding";
        readonly position_id: string;
        readonly period_start: string;
        readonly period_end: string;
        readonly delta: { readonly raw: string };
      }
    | {
        readonly event_type: "liquidation";
        readonly execution_id: string;
        readonly position_id: string;
      };
}
export interface LedgerProjection {
  readonly schema_version: typeof LEDGER_VERSION;
  readonly scope: LedgerScope;
  readonly last_sequence: string;
  /** USD at 6 decimals. Cash only, not equity, spendable margin or marked PnL. */
  readonly cash_usd_raw: string;
  readonly positions: readonly {
    position_id: string;
    /** Signed BTC at 8 decimals. */
    quantity_btc_raw: string;
  }[];
}
function requireLedger(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_LEDGER_${code}`);
}
export function ledgerScope(identity: LedgerIdentityInput): LedgerScope {
  return {
    mode: identity.account.mode,
    account_id: identity.account.account_id,
    experiment_id: identity.account.experiment_id,
    instrument_id: identity.instrument.instrument_id,
    instrument_version: identity.instrument.instrument_version,
  };
}
/** Replay committed sequence, never arrival order from SQL or economic timestamp.
 * occurred_at remains available for economic-time accounting in S2/S6. */
export function replayLedger(
  identity: LedgerIdentityInput,
  input: readonly LedgerReplayEvent[],
): LedgerProjection {
  const scope = ledgerScope(identity);
  const events = [...input].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence)
      ? -1
      : BigInt(a.sequence) > BigInt(b.sequence)
        ? 1
        : 0,
  );
  let cash = 0n,
    sequence = 0n;
  const positions = new Map<string, bigint>();
  const executions = new Map<
    string,
    { event: LedgerReplayEvent; closed: boolean }
  >();
  const ids = new Set<string>(),
    fees = new Set<string>(),
    liquidations = new Set<string>(),
    funding = new Set<string>(),
    transactions = new Set<string>();
  let currentTransaction = "";
  for (const event of events) {
    requireLedger(
      Object.entries(scope).every(
        ([key, value]) => event[key as keyof LedgerScope] === value,
      ),
      "OWNERSHIP",
    );
    requireLedger(BigInt(event.sequence) === sequence + 1n, "SEQUENCE");
    requireLedger(!ids.has(event.event_id), "IDEMPOTENCY_COLLISION");
    requireLedger(
      event.occurred_at >= identity.experiment.started_at,
      "BEFORE_GENESIS",
    );
    if (currentTransaction !== event.transaction_id) {
      requireLedger(
        !transactions.has(event.transaction_id),
        "TRANSACTION_ORDER",
      );
      transactions.add(event.transaction_id);
      currentTransaction = event.transaction_id;
    }
    const p = event.payload;
    requireLedger(
      sequence !== 0n ||
        (p.event_type === "cash" &&
          p.reason === "initial_allocation" &&
          p.delta.raw === "1000000000" &&
          event.event_id === "genesis" &&
          event.transaction_id === "genesis" &&
          event.cause_id === identity.experiment.experiment_id &&
          event.occurred_at === identity.experiment.started_at),
      "GENESIS",
    );
    switch (p.event_type) {
      case "cash":
        requireLedger(
          p.reason !== "initial_allocation" || sequence === 0n,
          "GENESIS_EXISTS",
        );
        requireLedger(p.delta.raw !== "0", "ZERO_CAPITAL");
        cash += BigInt(p.delta.raw);
        break;
      case "fill": {
        requireLedger(!executions.has(p.execution_id), "EXECUTION_EXISTS");
        requireLedger(
          BigInt(p.quantity.raw) > 0n &&
            BigInt(p.price.raw) > 0n &&
            BigInt(identity.instrument.quantity_step.raw) > 0n &&
            BigInt(identity.instrument.tick_size.raw) > 0n &&
            BigInt(p.quantity.raw) %
              BigInt(identity.instrument.quantity_step.raw) ===
              0n &&
            BigInt(p.price.raw) % BigInt(identity.instrument.tick_size.raw) ===
              0n,
          "INEXACT_FILL",
        );
        const before = positions.get(p.position_id) ?? 0n;
        const after =
          before + (p.side === "buy" ? 1n : -1n) * BigInt(p.quantity.raw);
        positions.set(p.position_id, after);
        executions.set(p.execution_id, {
          event,
          closed: before !== 0n && after === 0n,
        });
        break;
      }
      case "fee": {
        const fill = executions.get(p.execution_id)?.event;
        requireLedger(
          !!fill &&
            fill.occurred_at <= event.occurred_at &&
            !fees.has(p.execution_id),
          "FEE_EXECUTION",
        );
        fees.add(p.execution_id);
        cash += BigInt(p.delta.raw);
        break;
      }
      case "funding": {
        const key = JSON.stringify([
          p.position_id,
          p.period_start,
          p.period_end,
        ]);
        requireLedger(
          positions.has(p.position_id) && !funding.has(key),
          "FUNDING_POSITION_OR_PERIOD",
        );
        funding.add(key);
        cash += BigInt(p.delta.raw);
        break;
      }
      case "liquidation": {
        const execution = executions.get(p.execution_id);
        const fill = execution?.event;
        requireLedger(
          !!execution?.closed &&
            fill?.payload.event_type === "fill" &&
            fill.payload.position_id === p.position_id &&
            fill.transaction_id === event.transaction_id &&
            fill.occurred_at === event.occurred_at &&
            positions.get(p.position_id) === 0n &&
            !liquidations.has(p.execution_id),
          "LIQUIDATION_EXECUTION",
        );
        liquidations.add(p.execution_id); // Marker only: the linked fill/fee carry deltas.
        break;
      }
      default:
        throw new Error("BTC_LEDGER_UNSUPPORTED_EVENT");
    }
    sequence += 1n;
    ids.add(event.event_id);
  }
  requireLedger(sequence > 0n, "GENESIS_REQUIRED");
  return {
    schema_version: LEDGER_VERSION,
    scope,
    last_sequence: sequence.toString(),
    cash_usd_raw: cash.toString(),
    positions: [...positions]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([position_id, quantity]) => ({
        position_id,
        quantity_btc_raw: quantity.toString(),
      })),
  };
}
