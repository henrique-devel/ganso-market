import type { MarketMessage, PriceChangeEntry, PriceLevel } from "./types.js";

// The market channel delivers frames as a JSON array of event objects (even for
// a single event); parse defensively for both array and single-object frames.
export function parseMarketFrame(raw: string): MarketMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const messages: MarketMessage[] = [];
  for (const item of items) {
    const message = parseMessage(item);
    if (message !== null) {
      messages.push(message);
    }
  }
  return messages;
}

function parseMessage(raw: unknown): MarketMessage | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  switch (record.event_type) {
    case "book":
      return parseBook(record);
    case "price_change":
      return parsePriceChange(record);
    case "last_trade_price":
      return parseLastTrade(record);
    case "tick_size_change":
      return parseTickSize(record);
    default:
      return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseLevels(value: unknown): PriceLevel[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const levels: PriceLevel[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    const price = str(record.price);
    const size = str(record.size);
    if (price === null || size === null) {
      return null;
    }
    levels.push({ price, size });
  }
  return levels;
}

function parseBook(record: Record<string, unknown>): MarketMessage | null {
  const market = str(record.market);
  const assetId = str(record.asset_id);
  const timestamp = str(record.timestamp);
  const hash = str(record.hash);
  const bids = parseLevels(record.bids);
  const asks = parseLevels(record.asks);
  if (
    market === null ||
    assetId === null ||
    timestamp === null ||
    hash === null ||
    bids === null ||
    asks === null
  ) {
    return null;
  }
  return {
    event_type: "book",
    market,
    asset_id: assetId,
    timestamp,
    hash,
    bids,
    asks,
  };
}

function parseSide(value: unknown): "BUY" | "SELL" | null {
  return value === "BUY" || value === "SELL" ? value : null;
}

function parsePriceChange(
  record: Record<string, unknown>,
): MarketMessage | null {
  const market = str(record.market);
  const timestamp = str(record.timestamp);
  if (
    market === null ||
    timestamp === null ||
    !Array.isArray(record.price_changes)
  ) {
    return null;
  }
  const changes: PriceChangeEntry[] = [];
  for (const item of record.price_changes) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const entry = item as Record<string, unknown>;
    const assetId = str(entry.asset_id);
    const price = str(entry.price);
    const size = str(entry.size);
    const side = parseSide(entry.side);
    if (assetId === null || price === null || size === null || side === null) {
      return null;
    }
    changes.push({ asset_id: assetId, price, size, side });
  }
  return {
    event_type: "price_change",
    market,
    price_changes: changes,
    timestamp,
  };
}

function parseLastTrade(record: Record<string, unknown>): MarketMessage | null {
  const market = str(record.market);
  const assetId = str(record.asset_id);
  const price = str(record.price);
  const side = parseSide(record.side);
  const timestamp = str(record.timestamp);
  if (
    market === null ||
    assetId === null ||
    price === null ||
    side === null ||
    timestamp === null
  ) {
    return null;
  }
  return {
    event_type: "last_trade_price",
    market,
    asset_id: assetId,
    price,
    side,
    timestamp,
  };
}

function parseTickSize(record: Record<string, unknown>): MarketMessage | null {
  const market = str(record.market);
  const assetId = str(record.asset_id);
  const oldTick = str(record.old_tick_size);
  const newTick = str(record.new_tick_size);
  const timestamp = str(record.timestamp);
  if (
    market === null ||
    assetId === null ||
    oldTick === null ||
    newTick === null ||
    timestamp === null
  ) {
    return null;
  }
  return {
    event_type: "tick_size_change",
    market,
    asset_id: assetId,
    old_tick_size: oldTick,
    new_tick_size: newTick,
    timestamp,
  };
}
