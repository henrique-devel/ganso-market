// DATA-03: deliberately bounded fixture replay, never a claim that an arbitrary
// historical corpus is complete. Archive byte/schema verification belongs to
// the exporter; these profiles check representational and economic meaning.
import { OrderBook } from "./book.js";
import { SCALE, formatScaled, mul, parseScaled } from "./fundamental/fixed.js";
import type { PriceLevel } from "./types.js";

export type ArchiveReplayProfile = "raw-l2" | "paper-ledger";
export type ArchiveReplayRows = Readonly<Record<string, readonly string[]>>;
type Row = Record<string, unknown>;
class JsonNumber {
  constructor(readonly lexeme: string) {}
}

function requireThat(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`ARCHIVE_REPLAY: ${reason}`);
}

// JSON numeric lexemes stay opaque, including nested JSONB numeric values.
// JSON.parse is used ONLY for quoted strings, never an unsafe numeric token.
function parseRow(source: string): Row {
  let at = 0;
  const whitespace = (): void => {
    while (/[\t\r\n ]/.test(source[at] ?? "") && at < source.length) at += 1;
  };
  const value = (depth: number): unknown => {
    requireThat(depth < 64, "JSON nesting limit");
    whitespace();
    const char = source[at];
    if (char === '"') {
      const start = at++;
      while (at < source.length) {
        if (source[at++] === '"') return JSON.parse(source.slice(start, at));
        if (source[at - 1] === "\\") at += 1;
      }
      throw new Error("ARCHIVE_REPLAY: unterminated JSON string");
    }
    if (char === "{" || char === "[") {
      const isObject = char === "{";
      const result: Row = Object.create(null) as Row;
      const list: unknown[] = [];
      const end = isObject ? "}" : "]";
      at += 1;
      whitespace();
      if (source[at] === end) {
        at += 1;
        return isObject ? result : list;
      }
      while (at < source.length) {
        if (isObject) {
          whitespace();
          requireThat(source[at] === '"', "invalid JSON object key");
          const key = value(depth + 1) as string;
          requireThat(!Object.hasOwn(result, key), "duplicate JSON object key");
          whitespace();
          requireThat(source[at++] === ":", "invalid JSON object separator");
          result[key] = value(depth + 1);
        } else list.push(value(depth + 1));
        whitespace();
        if (source[at] === end) {
          at += 1;
          return isObject ? result : list;
        }
        requireThat(
          source[at++] === ",",
          "invalid JSON array/object separator",
        );
      }
      throw new Error("ARCHIVE_REPLAY: unterminated JSON object/array");
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(literal, at)) {
        at += literal.length;
        return parsed;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(at),
    );
    requireThat(number !== null, "invalid JSON value");
    at += number[0].length;
    return new JsonNumber(number[0]);
  };
  const parsed = value(0);
  whitespace();
  requireThat(at === source.length, "trailing JSON data");
  return object(parsed);
}

function object(value: unknown): Row {
  requireThat(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected object",
  );
  return value as Row;
}

function string(value: unknown): string {
  requireThat(
    typeof value === "string" && value.length > 0,
    "expected nonempty string",
  );
  return value;
}

function id(value: unknown): bigint {
  const text = value instanceof JsonNumber ? value.lexeme : string(value);
  requireThat(/^[1-9]\d*$/.test(text), "invalid positive integer identity");
  return BigInt(text);
}

function decimal(value: unknown, positive = false): bigint {
  const amount = parseScaled(string(value));
  requireThat(
    amount !== null && (positive ? amount > 0n : amount >= 0n),
    "invalid exact decimal",
  );
  return amount;
}

function price(value: unknown): bigint {
  const amount = decimal(value, true);
  requireThat(amount <= SCALE, "price exceeds one USD");
  return amount;
}

function timestamp(value: unknown): bigint {
  const text = string(value);
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(
      text,
    );
  requireThat(match !== null, "timestamp must preserve UTC microseconds");
  const seconds = `${match[1]}Z`;
  const date = new Date(seconds);
  requireThat(
    Number.isFinite(date.getTime()) &&
      date.toISOString() === `${match[1]}.000Z`,
    "invalid UTC timestamp",
  );
  return (
    BigInt(date.getTime()) * 1_000n + BigInt((match[2] ?? "").padEnd(6, "0"))
  );
}

function levels(value: unknown): PriceLevel[] {
  requireThat(
    Array.isArray(value) && value.length > 0 && value.length <= 1_000,
    "missing or oversized full L2/book slice",
  );
  const seen = new Set<string>();
  return value.map((item) => {
    const row = object(item);
    const key = price(row["price"]).toString();
    requireThat(!seen.has(key), "duplicate price level");
    seen.add(key);
    decimal(row["size"], true);
    return { price: string(row["price"]), size: string(row["size"]) };
  });
}

function noReferences(row: Row, names: readonly string[]): void {
  for (const name of names)
    requireThat(
      row[name] === null || row[name] === undefined,
      `unsupported dependency ${name}`,
    );
}

function tables(
  rows: ArchiveReplayRows,
  names: readonly string[],
): Record<string, Row[]> {
  requireThat(
    Object.keys(rows).sort().join(",") === [...names].sort().join(","),
    "profile requires exact source tables; aggregates cannot replace raw rows",
  );
  const out: Record<string, Row[]> = {};
  for (const name of names) {
    const supplied = rows[name];
    requireThat(
      supplied !== undefined && supplied.length > 0 && supplied.length <= 1_000,
      "empty or oversized fixture table",
    );
    out[name] = supplied.map(parseRow);
  }
  return out;
}

function replayRaw(rows: ArchiveReplayRows): Record<string, unknown> {
  const parsed = tables(rows, [
    "polymarket_book_snapshots_full",
    "polymarket_book_deltas",
  ]);
  const anchors = parsed["polymarket_book_snapshots_full"]!;
  const deltas = parsed["polymarket_book_deltas"]!;
  requireThat(anchors.length === 1, "fixture requires exactly one full anchor");
  const anchor = anchors[0]!;
  const tokenId = string(anchor["token_id"]);
  const anchorId = id(anchor["snapshot_id"]).toString();
  const anchorAt = timestamp(anchor["received_at"]);
  const anchorSourceAt = timestamp(anchor["source_ts"]);
  requireThat(
    anchorSourceAt <= anchorAt,
    "anchor source timestamp after reception",
  );
  const book = new OrderBook();
  const encodings = new Map<string, string>();
  const verifyPriceEncoding = (value: unknown): string => {
    const amount = price(value).toString();
    const text = string(value);
    requireThat(
      !encodings.has(amount) || encodings.get(amount) === text,
      "inconsistent equivalent price encoding",
    );
    encodings.set(amount, text);
    return text;
  };
  const bids = levels(anchor["bids_json"]);
  const asks = levels(anchor["asks_json"]);
  for (const level of [...bids, ...asks]) verifyPriceEncoding(level.price);
  book.replace(bids, asks);
  const sorted = [...deltas].sort((a, b) =>
    id(a["delta_id"]) < id(b["delta_id"]) ? -1 : 1,
  );
  let lastId: bigint | null = null;
  let lastAt = anchorAt;
  let lastSourceAt = anchorSourceAt;
  for (const delta of sorted) {
    const deltaId = id(delta["delta_id"]);
    requireThat(
      lastId === null || deltaId === lastId + 1n,
      "synthetic fixture delta identity gap/duplicate",
    );
    requireThat(
      delta["token_id"] === tokenId,
      "delta token differs from anchor",
    );
    const receivedAt = timestamp(delta["received_at"]);
    requireThat(
      receivedAt > anchorAt && receivedAt >= lastAt,
      "delta precedes anchor or timestamp order",
    );
    const sourceAt = timestamp(delta["source_ts"]);
    requireThat(
      sourceAt >= lastSourceAt && sourceAt <= receivedAt,
      "delta source timestamp order/coverage",
    );
    const side = delta["side"];
    requireThat(side === "BUY" || side === "SELL", "invalid delta side");
    verifyPriceEncoding(delta["price"]);
    decimal(delta["size"]);
    book.applyPriceChange({
      asset_id: tokenId,
      side,
      price: string(delta["price"]),
      size: string(delta["size"]),
    });
    lastId = deltaId;
    lastAt = receivedAt;
    lastSourceAt = sourceAt;
  }
  return {
    tokenId,
    anchorId,
    anchorReceivedAt: string(anchor["received_at"]),
    anchorSourceTs: string(anchor["source_ts"]),
    firstDeltaId: id(sorted[0]!["delta_id"]).toString(),
    lastDeltaId: lastId!.toString(),
    lastReceivedAt: string(sorted.at(-1)!["received_at"]),
    deltasApplied: deltas.length,
    lastSourceTs: string(sorted.at(-1)!["source_ts"]),
    bids: book.topBids(1_000),
    asks: book.topAsks(1_000),
    continuity:
      "synthetic-global-id-adjacency-only; real token continuity unproven",
  };
}

function replayPaper(rows: ArchiveReplayRows): Record<string, unknown> {
  const parsed = tables(rows, [
    "paper_orders",
    "paper_ledger_events",
    "paper_positions",
  ]);
  requireThat(
    parsed["paper_orders"]!.length === 1 &&
      parsed["paper_positions"]!.length === 1,
    "fixture requires one order and one position",
  );
  const order = parsed["paper_orders"]![0]!;
  const position = parsed["paper_positions"]![0]!;
  requireThat(
    order["status"] === "filled" &&
      order["source"] === "manual" &&
      order["side"] === "BUY",
    "fixture requires a closed manual BUY order",
  );
  requireThat(
    ["GTC", "GTD", "FAK", "FOK"].includes(string(order["order_type"])),
    "invalid order type",
  );
  noReferences(order, [
    "condition_id",
    "decision_id",
    "strategy_id",
    "resolution_generation",
    "resolution_risk_claim",
  ]);
  noReferences(position, ["condition_id", "resolved_at"]);
  const orderId = string(order["order_id"]);
  const tokenId = string(order["token_id"]);
  requireThat(position["token_id"] === tokenId, "position token mismatch");
  const size = decimal(order["size"], true);
  requireThat(
    decimal(order["filled_size"], true) === size,
    "order not fully filled",
  );
  const limit = price(order["limit_price"]);
  const decidedAt = timestamp(order["decided_at"]);
  const acceptedAt = timestamp(order["accepted_at"]);
  const closedAt = timestamp(order["closed_at"]);
  requireThat(
    decidedAt <= acceptedAt && acceptedAt <= closedAt,
    "invalid order timestamp order",
  );
  const events = [...parsed["paper_ledger_events"]!].sort((a, b) => {
    const ta = timestamp(a["event_ts"]);
    const tb = timestamp(b["event_ts"]);
    return ta === tb
      ? id(a["event_id"]) < id(b["event_id"])
        ? -1
        : 1
      : ta < tb
        ? -1
        : 1;
  });
  const keys = new Set<string>();
  const ids = new Set<string>();
  let accepted = false;
  let filled = 0n;
  let cost = 0n;
  let fees = 0n;
  let fills = 0;
  let firstFillAt: bigint | null = null;
  for (const event of events) {
    const eventId = id(event["event_id"]).toString();
    const key = string(event["idempotency_key"]);
    requireThat(
      !ids.has(eventId) && !keys.has(key),
      "duplicate ledger identity",
    );
    ids.add(eventId);
    keys.add(key);
    requireThat(
      event["order_id"] === orderId && event["token_id"] === tokenId,
      "missing order/token dependency",
    );
    noReferences(event, ["condition_id"]);
    const at = timestamp(event["event_ts"]);
    requireThat(
      at >= decidedAt && at <= closedAt,
      "ledger outside order lifetime",
    );
    const payload = object(event["payload_json"]);
    noReferences(payload, [
      "decision_id",
      "strategy_id",
      "resolution_generation",
      "fee_param_version_id",
      "intent",
      "override_veto",
    ]);
    requireThat(payload["side"] === "BUY", "ledger side mismatch");
    if (event["event_type"] === "order_accepted") {
      requireThat(
        !accepted && fills === 0 && at === decidedAt,
        "invalid acceptance ledger",
      );
      requireThat(
        payload["source"] === "manual" &&
          payload["order_type"] === order["order_type"],
        "acceptance provenance mismatch",
      );
      requireThat(
        price(payload["limit_price"]) === limit &&
          decimal(payload["size"], true) === size,
        "acceptance amount mismatch",
      );
      accepted = true;
    } else {
      requireThat(
        event["event_type"] === "fill" && accepted && at >= acceptedAt,
        "unsupported event or missing acceptance",
      );
      const fillSize = decimal(payload["size"], true);
      const fillPrice = price(payload["price"]);
      requireThat(fillPrice <= limit, "fill violates order limit");
      const slice = levels(payload["book_slice"]);
      const consumed = slice
        .filter((level) => price(level.price) === fillPrice)
        .reduce((total, level) => total + decimal(level.size, true), 0n);
      requireThat(consumed >= fillSize, "fill missing consumed L2 evidence");
      filled += fillSize;
      cost += mul(fillPrice, fillSize);
      fees += decimal(payload["fee"]);
      fills += 1;
      firstFillAt ??= at;
    }
  }
  requireThat(
    accepted && fills > 0 && filled === size,
    "incomplete order ledger closure",
  );
  requireThat(
    decimal(position["shares"], true) === filled &&
      decimal(position["cost_usd"]) === cost &&
      decimal(position["fees_paid_usd"]) === fees,
    "position shares/cost/fees reconciliation failed",
  );
  requireThat(
    parseScaled(string(position["realized_pnl_usd"])) === -fees,
    "position realized PnL reconciliation failed",
  );
  requireThat(
    timestamp(position["opened_at"]) === firstFillAt,
    "position timestamp reconciliation failed",
  );
  return {
    orderId,
    tokenId,
    eventIds: events.map((event) => id(event["event_id"]).toString()),
    eventCount: events.length,
    fills,
    closedAt: string(order["closed_at"]),
    openedAt: string(position["opened_at"]),
    shares: formatScaled(filled, 9),
    costUsd: formatScaled(cost, 9),
    feesPaidUsd: formatScaled(fees, 9),
    realizedPnlUsd: formatScaled(-fees, 9),
  };
}

/**
 * Supported synthetic fixtures only. In particular global delta_id adjacency
 * cannot establish a real token's feed continuity or historical completeness.
 * Every result remains in HOLD and grants no permission to delete its source.
 */
export function verifyArchiveReplay(
  profile: ArchiveReplayProfile,
  rows: ArchiveReplayRows,
): Record<string, unknown> {
  requireThat(
    profile === "raw-l2" || profile === "paper-ledger",
    "unsupported profile",
  );
  return {
    profile,
    fixtureOnly: true,
    executionAllowed: false,
    historicalCompleteness: "unproven",
    ...(profile === "raw-l2" ? replayRaw(rows) : replayPaper(rows)),
  };
}
