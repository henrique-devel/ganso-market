declare const canonicalIntegerBrand: unique symbol;
declare const canonicalNonNegativeIntegerBrand: unique symbol;
declare const correlationIdBrand: unique symbol;
declare const reasonCodeBrand: unique symbol;
declare const semVerBrand: unique symbol;
declare const sha256HexBrand: unique symbol;
declare const utcRfc3339TimestampBrand: unique symbol;

/** An integer encoded at a JSON boundary without precision loss. */
export type CanonicalIntegerString = string & {
  readonly [canonicalIntegerBrand]: "CanonicalIntegerString";
};

/** A non-negative integer encoded at a JSON boundary without precision loss. */
export type CanonicalNonNegativeIntegerString = string & {
  readonly [canonicalNonNegativeIntegerBrand]: "CanonicalNonNegativeIntegerString";
};

export type CorrelationId = string & {
  readonly [correlationIdBrand]: "CorrelationId";
};

export type ReasonCode = string & {
  readonly [reasonCodeBrand]: "ReasonCode";
};

export type SemVerString = string & {
  readonly [semVerBrand]: "SemVerString";
};

export type Sha256Hex = string & {
  readonly [sha256HexBrand]: "Sha256Hex";
};

export type UtcRfc3339Timestamp = string & {
  readonly [utcRfc3339TimestampBrand]: "UtcRfc3339Timestamp";
};

export type ExecutionMode = "paper";

export type Commitment = "processed" | "confirmed" | "finalized";

/** JSON representation. `raw` is a canonical base-10 integer string. */
export interface MoneyAmountJson {
  readonly raw: CanonicalIntegerString;
  readonly decimals: number;
  readonly asset_id: string;
}

/** Internal exact representation. `raw` must never be converted through Number. */
export interface MoneyAmount {
  readonly raw: bigint;
  readonly decimals: number;
  readonly asset_id: string;
}

export interface EventIdentity {
  readonly idempotency_key: string;
  readonly slot: CanonicalNonNegativeIntegerString;
  readonly commitment: Commitment;
  readonly source_timestamp: UtcRfc3339Timestamp;
  readonly received_at: UtcRfc3339Timestamp;
  readonly parser_version: SemVerString;
  readonly payload_hash: Sha256Hex;
}

export interface DataFreshness {
  readonly status: "fresh" | "stale" | "unknown";
  readonly as_of: UtcRfc3339Timestamp;
  readonly checked_at: UtcRfc3339Timestamp;
  readonly age_ms: number;
  readonly max_age_ms: number;
  readonly reason_codes: readonly ReasonCode[];
}

export interface ServiceCheck {
  readonly name: string;
  readonly status: "ready" | "not_ready";
  readonly reason_codes: readonly ReasonCode[];
}

export interface ServiceHealth {
  readonly service: string;
  readonly status: "live" | "ready" | "not_ready";
  readonly checked_at: UtcRfc3339Timestamp;
  readonly execution_mode: ExecutionMode;
  readonly correlation_id: CorrelationId;
  readonly reason_codes: readonly ReasonCode[];
  readonly checks: readonly ServiceCheck[];
}
