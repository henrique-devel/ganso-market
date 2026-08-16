import type { BookMessage, PriceChangeEntry, PriceLevel } from "./types.js";

const FRACTION_DIGITS = 9;

// Compare two non-negative decimal price strings exactly, without floats, by
// scaling to a fixed-point integer.
export function comparePriceStrings(a: string, b: string): number {
  const scaledA = toScaled(a);
  const scaledB = toScaled(b);
  if (scaledA < scaledB) {
    return -1;
  }
  if (scaledA > scaledB) {
    return 1;
  }
  return 0;
}

function toScaled(value: string): bigint {
  const [intPart, fracPart = ""] = value.split(".");
  const fraction = (fracPart + "0".repeat(FRACTION_DIGITS)).slice(
    0,
    FRACTION_DIGITS,
  );
  return BigInt((intPart === "" ? "0" : intPart) + fraction);
}

function isZeroSize(size: string): boolean {
  return toScaled(size) === 0n;
}

/**
 * Order book reconstructed from a snapshot and mutated by price-change deltas.
 * A delta's size is the new absolute size at that level; a zero size removes it.
 */
export class OrderBook {
  readonly #bids = new Map<string, string>();
  readonly #asks = new Map<string, string>();

  public static fromMessage(message: BookMessage): OrderBook {
    const book = new OrderBook();
    book.replace(message.bids, message.asks);
    return book;
  }

  public replace(
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
  ): void {
    this.#bids.clear();
    this.#asks.clear();
    for (const level of bids) {
      if (!isZeroSize(level.size)) {
        this.#bids.set(level.price, level.size);
      }
    }
    for (const level of asks) {
      if (!isZeroSize(level.size)) {
        this.#asks.set(level.price, level.size);
      }
    }
  }

  public applyPriceChange(entry: PriceChangeEntry): void {
    const side = entry.side === "BUY" ? this.#bids : this.#asks;
    if (isZeroSize(entry.size)) {
      side.delete(entry.price);
    } else {
      side.set(entry.price, entry.size);
    }
  }

  private levels(side: Map<string, string>, descending: boolean): PriceLevel[] {
    return [...side.entries()]
      .map(([price, size]): PriceLevel => ({ price, size }))
      .sort((left, right) =>
        descending
          ? comparePriceStrings(right.price, left.price)
          : comparePriceStrings(left.price, right.price),
      );
  }

  // Best bids are the highest prices; best asks are the lowest.
  public topBids(depth = 10): PriceLevel[] {
    return this.levels(this.#bids, true).slice(0, depth);
  }

  public topAsks(depth = 10): PriceLevel[] {
    return this.levels(this.#asks, false).slice(0, depth);
  }

  public bestBid(): PriceLevel | null {
    return this.topBids(1)[0] ?? null;
  }

  public bestAsk(): PriceLevel | null {
    return this.topAsks(1)[0] ?? null;
  }
}
