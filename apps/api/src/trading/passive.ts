/** Pure, deliberately low-fidelity paper model; no venue queue claim.
 * Exact-price opposing trades only. Each order starts behind the ENTIRE visible
 * quantity at its price (even if another simulated order counted it already).
 * Book cancellations never improve priority. A trade budget includes queue burn
 * and fills, is shared FIFO per account, and unused dust/remainder is discarded.
 * All edits cancel/replace with a new ID and priority; retries keep priority.
 * Fees round UP cumulatively over the order, never once per polling operation.
 */
export const PASSIVE_VERSION = "btc.passive.v1" as const;
export const PASSIVE_POLICY =
  "exact_price_full_displayed_queue_cancel_replace_v1" as const;
export interface PassiveIntent {
  schema_version: typeof PASSIVE_VERSION;
  limit_price_usd_raw: string;
  fee_metadata_id: string;
}
export interface PassiveQueue {
  ahead_btc_raw: string;
  fee_numerator: string;
  charged_usd_raw: string;
}
export function passiveQueue(input: {
  side: "buy" | "sell";
  limit: string;
  bids: readonly { price: { raw: string }; quantity: { raw: string } }[];
  asks: readonly { price: { raw: string }; quantity: { raw: string } }[];
}): PassiveQueue {
  const limit = BigInt(input.limit),
    own = input.side === "buy" ? input.bids : input.asks,
    opposite = input.side === "buy" ? input.asks : input.bids;
  if (!own.length || !opposite.length)
    throw new Error("BTC_PASSIVE_BOOK_EMPTY");
  if (
    input.side === "buy"
      ? limit >= BigInt(opposite[0]!.price.raw)
      : limit <= BigInt(opposite[0]!.price.raw)
  )
    throw new Error("BTC_PASSIVE_POST_ONLY_CROSS");
  // Unknown depth cannot be represented by a zero queue.
  if (
    input.side === "buy"
      ? limit < BigInt(own.at(-1)!.price.raw)
      : limit > BigInt(own.at(-1)!.price.raw)
  )
    throw new Error("BTC_PASSIVE_OUTSIDE_DEPTH");
  return {
    ahead_btc_raw:
      own.find((l) => l.price.raw === input.limit)?.quantity.raw ?? "0",
    fee_numerator: "0",
    charged_usd_raw: "0",
  };
}
export function consumePassiveTrade(input: {
  queue: PassiveQueue;
  side: "buy" | "sell";
  limit: string;
  remaining: string;
  step: string;
  feeRate: string;
  trade: { side: "buy" | "sell"; price: string; available: string };
}) {
  const { queue, trade } = input;
  if (trade.side === input.side || trade.price !== input.limit)
    return {
      queue: { ...queue },
      quantity: "0",
      fee: "0",
      available: trade.available,
    };
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  let available = BigInt(trade.available);
  const burn = min(available, BigInt(queue.ahead_btc_raw));
  available -= burn;
  const step = BigInt(input.step),
    quantity = (min(available, BigInt(input.remaining)) / step) * step,
    numerator =
      BigInt(queue.fee_numerator) +
      quantity * BigInt(input.limit) * BigInt(input.feeRate),
    charged =
      (numerator + 100_000_000_000_000_000n - 1n) / 100_000_000_000_000_000n;
  return {
    queue: {
      ahead_btc_raw: (BigInt(queue.ahead_btc_raw) - burn).toString(),
      fee_numerator: numerator.toString(),
      charged_usd_raw: charged.toString(),
    },
    quantity: quantity.toString(),
    fee: (charged - BigInt(queue.charged_usd_raw)).toString(),
    available: (available - quantity).toString(),
  };
}
