/** Pure BTC IOC book walk. Exact per-level prices (no rounded VWAP), BTC8,
 * USD6 and RATE9. Depth is supplied net of this account's prior executions.
 * Fee rounding occurs once across the IOC, then is allocated to its fills. */
export const BROKER_VERSION = "btc.ioc.v1" as const;
export interface IocIntent {
  schema_version: typeof BROKER_VERSION;
  decision_at: string;
  latency_ms: number;
  limit_price_usd_raw: string;
  fee_metadata_id: string;
}
export interface IocFill {
  price_usd_raw: string;
  quantity_btc_raw: string;
  fee_usd_raw: string;
}
export function walkIoc(input: {
  side: "buy" | "sell";
  quantity: string;
  limit: string;
  priceCap: string;
  step: string;
  feeRate: string;
  levels: readonly { price: { raw: string }; quantity: { raw: string } }[];
  consumed: readonly Pick<IocFill, "price_usd_raw" | "quantity_btc_raw">[];
}): IocFill[] {
  const used = new Map<string, bigint>();
  for (const fill of input.consumed)
    used.set(
      fill.price_usd_raw,
      (used.get(fill.price_usd_raw) ?? 0n) + BigInt(fill.quantity_btc_raw),
    );
  let remaining = BigInt(input.quantity),
    cumulative = 0n,
    charged = 0n;
  const fills: IocFill[] = [],
    step = BigInt(input.step);
  for (const level of input.levels) {
    const price = BigInt(level.price.raw),
      limit = BigInt(input.limit);
    if (input.side === "buy" ? price > limit : price < limit) break;
    // A sell can improve beyond the collateral/fee cap. Do not consume that
    // level under an insufficient reservation; the separate limit is a floor.
    if (price > BigInt(input.priceCap)) continue;
    const available =
      BigInt(level.quantity.raw) - (used.get(level.price.raw) ?? 0n);
    if (available <= 0n) continue;
    const quantity =
      ((available < remaining ? available : remaining) / step) * step;
    if (quantity === 0n) continue;
    cumulative += quantity * price * BigInt(input.feeRate);
    const fee =
      (cumulative + 100_000_000_000_000_000n - 1n) / 100_000_000_000_000_000n;
    fills.push({
      price_usd_raw: price.toString(),
      quantity_btc_raw: quantity.toString(),
      fee_usd_raw: (fee - charged).toString(),
    });
    charged = fee;
    remaining -= quantity;
    if (remaining === 0n) break;
  }
  return fills;
}
