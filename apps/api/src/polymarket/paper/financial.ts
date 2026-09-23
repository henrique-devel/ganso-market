import { compositeKey } from "../../trading/identity.js";
import {
  canonicalFingerprint,
  compareReplayOrder,
  utcBucketStart,
} from "../../trading/replay.js";
import {
  SCALE,
  divRound,
  formatScaled,
  mul,
  parseScaled,
} from "../../trading/fixed.js";
import { OWNERSHIP_VERSION, type AttributedLedgerEvent } from "./ownership.js";

export const FINANCIAL_VERSION = "financial-v2" as const;

export function financialOwnerKey(
  accountId: string,
  strategyId: string,
): string {
  return compositeKey([accountId, strategyId]);
}

export interface FinancialCapital {
  readonly accountId: string;
  readonly strategyId: string;
  readonly initialCashUsd: string | null;
  readonly capitalSourceRef: string;
}

/** A full executable valuation of this owner's quantity, never a token-wide mark. */
export interface FinancialMark {
  readonly accountId: string;
  readonly strategyId: string;
  readonly tokenId: string;
  readonly shares: string;
  readonly markValueSignedUsd: string | null;
  readonly stale: boolean;
  readonly sourceTs: Date | null;
  readonly receivedAt: Date | null;
}

export interface FinancialPosition {
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly shares: string;
  readonly costBasisUsd: string;
  readonly realizedPnlUsd: string;
  readonly feesPaidUsd: string;
  readonly cashflowUsd: string;
  readonly openedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly lastEventId: string;
  readonly lastEventTs: Date;
  readonly markValueSignedUsd: string | null;
  readonly markStale: boolean;
  readonly markSourceTs: Date | null;
  readonly markReceivedAt: Date | null;
  readonly unrealizedPnlUsd: string | null;
}

export interface FinancialOwnerState {
  readonly accountId: string;
  readonly strategyId: string;
  readonly ownershipVersion: typeof OWNERSHIP_VERSION;
  readonly accountingVersion: typeof FINANCIAL_VERSION;
  readonly initialCashUsd: string | null;
  readonly capitalSourceRef: string | null;
  readonly positions: ReadonlyMap<string, FinancialPosition>;
  readonly realizedPnlUsd: string;
  readonly feesPaidUsd: string;
  readonly cashflowUsd: string;
  readonly cashUsd: string | null;
  readonly unrealizedPnlUsd: string | null;
  readonly equityUsd: string | null;
  readonly marksFresh: boolean;
  /** UTC date keys (YYYY-MM-DD); weeks start on Monday. */
  readonly dailyRealizedPnlUsd: ReadonlyMap<string, string>;
  readonly weeklyRealizedPnlUsd: ReadonlyMap<string, string>;
}

export interface FinancialLedgerState {
  readonly ownershipVersion: typeof OWNERSHIP_VERSION;
  readonly accountingVersion: typeof FINANCIAL_VERSION;
  readonly owners: ReadonlyMap<string, FinancialOwnerState>;
  /** Unique event/owner applications; a global settlement can have several owners. */
  readonly eventCount: number;
  readonly realizedPnlUsd: string;
  readonly feesPaidUsd: string;
  readonly cashflowUsd: string;
}

interface MutablePosition {
  tokenId: string;
  conditionId: string | null;
  shares: bigint;
  basis: bigint;
  realized: bigint;
  fees: bigint;
  cashflow: bigint;
  openedAt: Date | null;
  resolvedAt: Date | null;
  lastEventId: string;
  lastEventTs: Date;
}

interface MutableOwner {
  accountId: string;
  strategyId: string;
  capital: bigint | null;
  capitalSourceRef: string | null;
  positions: Map<string, MutablePosition>;
  daily: Map<string, bigint>;
  weekly: Map<string, bigint>;
}

const decimal = (value: bigint): string => formatScaled(value, 9);
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const sign = (value: bigint): bigint => (value < 0n ? -1n : 1n);

function fail(reason: string): never {
  throw new Error(`FIN03_${reason}`);
}

function money(value: unknown, field: string): bigint {
  const parsed = typeof value === "string" ? parseScaled(value) : null;
  if (parsed === null) return fail(`INVALID_${field}`);
  return parsed;
}

function eventFee(event: AttributedLedgerEvent): bigint {
  const raw = event.payload["fee"];
  return money(raw === undefined ? "0" : raw, "FEE");
}

function timestamp(value: Date, field: string): number {
  const time = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isFinite(time)) return fail(`INVALID_${field}`);
  return time;
}

// Preserve the legacy failure code at the domain boundary.
const canonical = (value: unknown): string =>
  canonicalFingerprint(value, () => fail("INVALID_PAYLOAD"));

function fingerprint(event: AttributedLedgerEvent): string {
  return canonical({
    eventId: event.eventId,
    type: event.eventType,
    orderId: event.orderId,
    tokenId: event.tokenId,
    conditionId: event.conditionId,
    payload: event.payload,
    eventTs: timestamp(event.eventTs, "EVENT_TS"),
  });
}

function addBucket(
  buckets: Map<string, bigint>,
  key: string,
  delta: bigint,
): void {
  buckets.set(key, (buckets.get(key) ?? 0n) + delta);
}

function outputBuckets(
  buckets: ReadonlyMap<string, bigint>,
): Map<string, string> {
  return new Map([...buckets].map(([key, value]) => [key, decimal(value)]));
}

function blankOwner(accountId: string, strategyId: string): MutableOwner {
  if (accountId.length === 0 || strategyId.length === 0) fail("INVALID_OWNER");
  return {
    accountId,
    strategyId,
    capital: null,
    capitalSourceRef: null,
    positions: new Map(),
    daily: new Map(),
    weekly: new Map(),
  };
}

/**
 * The v2 economic fold is independent of ledger-v1. Late arrival rebuilds the
 * economic sequence, including realization buckets; ingestion only supplies a
 * cache watermark. Legacy short/cross-zero events remain measurable here.
 */
export function replayFinancialLedger(
  events: readonly AttributedLedgerEvent[],
  capitals: readonly FinancialCapital[] = [],
  marks: readonly FinancialMark[] = [],
  asOf?: Date,
): FinancialLedgerState {
  const cutoff = asOf === undefined ? Infinity : timestamp(asOf, "AS_OF");
  const owners = new Map<string, MutableOwner>();
  for (const capital of capitals) {
    const key = financialOwnerKey(capital.accountId, capital.strategyId);
    if (owners.has(key)) fail("DUPLICATE_CAPITAL");
    const owner = blankOwner(capital.accountId, capital.strategyId);
    owner.capital =
      capital.initialCashUsd === null
        ? null
        : money(capital.initialCashUsd, "CAPITAL");
    if (
      owner.capital !== null &&
      (owner.capital < 0n || !capital.capitalSourceRef)
    ) {
      fail("UNPROVEN_CAPITAL");
    }
    owner.capitalSourceRef = capital.capitalSourceRef;
    owners.set(key, owner);
  }

  const contents = new Map<string, { fingerprint: string; ownerKey: string }>();
  const attributed = new Map<string, string>();
  const ordered: AttributedLedgerEvent[] = [];
  for (const event of events) {
    const at = timestamp(event.eventTs, "EVENT_TS");
    timestamp(event.receivedAt, "RECEIVED_AT");
    if (event.owner.ownershipVersion !== OWNERSHIP_VERSION)
      fail("OWNERSHIP_VERSION");
    if (!/^\d+$/.test(event.eventId) || BigInt(event.eventId) <= 0n)
      fail("INVALID_EVENT_ID");
    if (at > cutoff) continue;
    const key = financialOwnerKey(
      event.owner.accountId,
      event.owner.strategyId,
    );
    const content = fingerprint(event);
    const prior = contents.get(event.idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== content) fail("IDEMPOTENCY_CONTENT_CONFLICT");
      if (prior.ownerKey !== key) {
        const global =
          event.orderId === null &&
          (event.eventType === "mark" ||
            (event.eventType === "resolution" && eventFee(event) === 0n));
        if (!global) fail("IDEMPOTENCY_OWNER_CONFLICT");
      }
    } else
      contents.set(event.idempotencyKey, {
        fingerprint: content,
        ownerKey: key,
      });
    const associationKey = compositeKey([event.idempotencyKey, key]);
    const association = canonical(event.owner);
    const previousAssociation = attributed.get(associationKey);
    if (previousAssociation !== undefined) {
      if (previousAssociation !== association)
        fail("IDEMPOTENCY_ATTRIBUTION_CONFLICT");
      continue;
    }
    attributed.set(associationKey, association);
    ordered.push(event);
  }
  ordered.sort(
    (a, b) =>
      compareReplayOrder(a, b) ||
      financialOwnerKey(a.owner.accountId, a.owner.strategyId).localeCompare(
        financialOwnerKey(b.owner.accountId, b.owner.strategyId),
      ),
  );
  const acceptances = new Map<string, AttributedLedgerEvent>();
  for (const event of ordered) {
    if (event.eventType === "order_accepted" && event.orderId !== null) {
      const key = compositeKey([
        event.orderId,
        financialOwnerKey(event.owner.accountId, event.owner.strategyId),
      ]);
      if (acceptances.has(key)) fail("DUPLICATE_ORDER_ACCEPTANCE");
      acceptances.set(key, event);
    }
  }

  for (const event of ordered) {
    const ownerKey = financialOwnerKey(
      event.owner.accountId,
      event.owner.strategyId,
    );
    const owner =
      owners.get(ownerKey) ??
      blankOwner(event.owner.accountId, event.owner.strategyId);
    owners.set(ownerKey, owner);
    if (event.eventType !== "fill" && event.eventType !== "resolution")
      continue;
    if (event.tokenId === null || event.tokenId.length === 0)
      fail("MISSING_TOKEN");
    const position = owner.positions.get(event.tokenId) ?? {
      tokenId: event.tokenId,
      conditionId: event.conditionId,
      shares: 0n,
      basis: 0n,
      realized: 0n,
      fees: 0n,
      cashflow: 0n,
      openedAt: null,
      resolvedAt: null,
      lastEventId: event.eventId,
      lastEventTs: event.eventTs,
    };
    if (
      position.conditionId !== null &&
      event.conditionId !== null &&
      position.conditionId !== event.conditionId
    )
      fail("CONDITION_CONFLICT");
    position.conditionId ??= event.conditionId;
    const fee = eventFee(event);
    if (fee < 0n) fail("NEGATIVE_FEE");
    let cashDelta: bigint;
    let realizedDelta = -fee;
    if (event.eventType === "fill") {
      if (position.resolvedAt !== null) fail("FILL_AFTER_RESOLUTION");
      if (event.orderId !== null) {
        const accepted = acceptances.get(
          compositeKey([event.orderId, ownerKey]),
        );
        if (
          accepted !== undefined &&
          (accepted.eventTs.getTime() > event.eventTs.getTime() ||
            (accepted.eventTs.getTime() === event.eventTs.getTime() &&
              accepted.idempotencyKey > event.idempotencyKey))
        ) {
          fail("FILL_BEFORE_ACCEPTANCE");
        }
        if (
          accepted !== undefined &&
          (accepted.tokenId !== event.tokenId ||
            accepted.conditionId !== event.conditionId)
        )
          fail("ORDER_IDENTITY_CONFLICT");
      }
      const side = event.payload["side"];
      const size = money(event.payload["size"], "SIZE");
      const price = money(event.payload["price"], "PRICE");
      if (
        (side !== "BUY" && side !== "SELL") ||
        size <= 0n ||
        price < 0n ||
        price > SCALE
      ) {
        fail("INVALID_FILL");
      }
      // Quantize once, then allocate that exact notional between closing/opening.
      const notional = mul(size, price);
      const signedSize = side === "BUY" ? size : -size;
      cashDelta = (side === "BUY" ? -notional : notional) - fee;
      const before = position.shares;
      if (before === 0n || sign(before) === sign(signedSize)) {
        position.basis += notional;
        if (before === 0n) position.openedAt = event.eventTs;
      } else {
        const closing = size < abs(before) ? size : abs(before);
        const basisRemoved =
          closing === abs(before)
            ? position.basis
            : divRound(position.basis * closing, abs(before));
        const closingNotional =
          closing === size ? notional : divRound(notional * closing, size);
        realizedDelta += sign(before) * (closingNotional - basisRemoved);
        position.basis -= basisRemoved;
        if (size > closing) {
          position.basis = notional - closingNotional;
          position.openedAt = event.eventTs;
        }
      }
      position.shares += signedSize;
      if (position.shares === 0n) position.basis = 0n;
    } else {
      const payout = money(event.payload["outcome_price"], "PAYOUT");
      if (payout < 0n || payout > SCALE) fail("INVALID_PAYOUT");
      if (position.resolvedAt !== null) fail("DUPLICATE_RESOLUTION");
      const settlement = mul(position.shares, payout);
      cashDelta = settlement - fee;
      realizedDelta += settlement - sign(position.shares) * position.basis;
      position.shares = 0n;
      position.basis = 0n;
      position.resolvedAt = event.eventTs;
    }
    position.cashflow += cashDelta;
    position.realized += realizedDelta;
    position.fees += fee;
    if (BigInt(event.eventId) > BigInt(position.lastEventId))
      position.lastEventId = event.eventId;
    position.lastEventTs = event.eventTs;
    owner.positions.set(event.tokenId, position);
    addBucket(owner.daily, utcBucketStart(event.eventTs, false), realizedDelta);
    addBucket(owner.weekly, utcBucketStart(event.eventTs, true), realizedDelta);
  }

  const output = new Map<string, FinancialOwnerState>();
  let realizedTotal = 0n;
  let feesTotal = 0n;
  let cashflowTotal = 0n;
  for (const [key, owner] of owners) {
    let realized = 0n;
    let fees = 0n;
    let cashflow = 0n;
    let signedBasis = 0n;
    const positions = new Map<string, FinancialPosition>();
    for (const [tokenId, position] of owner.positions) {
      realized += position.realized;
      fees += position.fees;
      cashflow += position.cashflow;
      signedBasis += sign(position.shares) * position.basis;
      positions.set(tokenId, {
        tokenId,
        conditionId: position.conditionId,
        shares: decimal(position.shares),
        costBasisUsd: decimal(position.basis),
        realizedPnlUsd: decimal(position.realized),
        feesPaidUsd: decimal(position.fees),
        cashflowUsd: decimal(position.cashflow),
        openedAt: position.openedAt,
        resolvedAt: position.resolvedAt,
        lastEventId: position.lastEventId,
        lastEventTs: position.lastEventTs,
        markValueSignedUsd: null,
        markStale: position.shares !== 0n,
        markSourceTs: null,
        markReceivedAt: null,
        unrealizedPnlUsd: position.shares === 0n ? decimal(0n) : null,
      });
    }
    if (cashflow !== realized - signedBasis) fail("CASH_RECONCILIATION");
    realizedTotal += realized;
    feesTotal += fees;
    cashflowTotal += cashflow;
    output.set(key, {
      accountId: owner.accountId,
      strategyId: owner.strategyId,
      ownershipVersion: OWNERSHIP_VERSION,
      accountingVersion: FINANCIAL_VERSION,
      initialCashUsd: owner.capital === null ? null : decimal(owner.capital),
      capitalSourceRef: owner.capitalSourceRef,
      positions,
      realizedPnlUsd: decimal(realized),
      feesPaidUsd: decimal(fees),
      cashflowUsd: decimal(cashflow),
      cashUsd:
        owner.capital === null ? null : decimal(owner.capital + cashflow),
      unrealizedPnlUsd: null,
      equityUsd: null,
      marksFresh: false,
      dailyRealizedPnlUsd: outputBuckets(owner.daily),
      weeklyRealizedPnlUsd: outputBuckets(owner.weekly),
    });
  }
  return applyFinancialMarks(
    {
      ownershipVersion: OWNERSHIP_VERSION,
      accountingVersion: FINANCIAL_VERSION,
      owners: output,
      eventCount: ordered.length,
      realizedPnlUsd: decimal(realizedTotal),
      feesPaidUsd: decimal(feesTotal),
      cashflowUsd: decimal(cashflowTotal),
    },
    marks,
    asOf,
  );
}

/** Apply a complete mark snapshot; omitted marks become explicitly unavailable. */
export function applyFinancialMarks(
  state: FinancialLedgerState,
  marks: readonly FinancialMark[],
  asOf?: Date,
): FinancialLedgerState {
  const cutoff = asOf === undefined ? Infinity : timestamp(asOf, "AS_OF");
  const byPosition = new Map<string, FinancialMark>();
  for (const mark of marks) {
    const key = compositeKey([mark.accountId, mark.strategyId, mark.tokenId]);
    if (byPosition.has(key)) fail("DUPLICATE_MARK");
    byPosition.set(key, mark);
  }
  const owners = new Map<string, FinancialOwnerState>();
  for (const [ownerKey, owner] of state.owners) {
    const positions = new Map<string, FinancialPosition>();
    let unrealized = 0n;
    let signedMarkTotal = 0n;
    let fresh = true;
    for (const [tokenId, position] of owner.positions) {
      const shares = money(position.shares, "SHARES");
      const mark = byPosition.get(
        compositeKey([owner.accountId, owner.strategyId, tokenId]),
      );
      let value: bigint | null =
        shares === 0n || position.markValueSignedUsd === null
          ? null
          : money(position.markValueSignedUsd, "MARK_VALUE");
      let markStale = shares !== 0n;
      let sourceTs: Date | null = shares === 0n ? null : position.markSourceTs;
      let receivedAt: Date | null =
        shares === 0n ? null : position.markReceivedAt;
      if (shares !== 0n && mark !== undefined) {
        const markShares = money(mark.shares, "MARK_SHARES");
        const parsed =
          mark.markValueSignedUsd === null
            ? null
            : money(mark.markValueSignedUsd, "MARK_VALUE");
        if (mark.sourceTs !== null) timestamp(mark.sourceTs, "MARK_SOURCE_TS");
        if (mark.receivedAt !== null)
          timestamp(mark.receivedAt, "MARK_RECEIVED_AT");
        if (markShares === shares) {
          if (parsed !== null && parsed !== 0n && sign(parsed) !== sign(shares))
            fail("MARK_SIGN");
          value = parsed;
          sourceTs = mark.sourceTs;
          receivedAt = mark.receivedAt;
          markStale =
            mark.stale ||
            value === null ||
            sourceTs === null ||
            receivedAt === null ||
            sourceTs.getTime() > cutoff ||
            receivedAt.getTime() > cutoff;
        } else {
          value = null;
          sourceTs = null;
          receivedAt = null;
        }
      }
      const openPnl =
        shares === 0n
          ? 0n
          : markStale || value === null
            ? null
            : value - sign(shares) * money(position.costBasisUsd, "BASIS");
      if (openPnl === null) fresh = false;
      else {
        unrealized += openPnl;
        signedMarkTotal += value ?? 0n;
      }
      positions.set(tokenId, {
        ...position,
        markValueSignedUsd: value === null ? null : decimal(value),
        markStale,
        markSourceTs: sourceTs,
        markReceivedAt: receivedAt,
        unrealizedPnlUsd: openPnl === null ? null : decimal(openPnl),
      });
    }
    const equity =
      owner.cashUsd === null || !fresh
        ? null
        : money(owner.cashUsd, "CASH") + signedMarkTotal;
    if (
      equity !== null &&
      owner.initialCashUsd !== null &&
      equity !==
        money(owner.initialCashUsd, "CAPITAL") +
          money(owner.realizedPnlUsd, "REALIZED") +
          unrealized
    ) {
      fail("EQUITY_RECONCILIATION");
    }
    owners.set(ownerKey, {
      ...owner,
      positions,
      marksFresh: fresh,
      unrealizedPnlUsd: fresh ? decimal(unrealized) : null,
      equityUsd: equity === null ? null : decimal(equity),
    });
  }
  return { ...state, owners };
}
