import {
  LIVE_VERSION,
  type LiveIdentity,
} from "../../src/venues/hyperliquid/live-contract.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { sizeJevEntry } from "../../src/storage/jev-sizing.js";
import { parseHyperliquidBtcMetadata } from "../../src/venues/hyperliquid/metadata.js";
import { metadata } from "../trading/bars-fixture.js";
import {
  LIVE_COMMAND_VERSION,
  type LiveCommand,
} from "../../src/venues/hyperliquid/live-execution.js";
import { jevIdentity } from "../trading/jev-v2-fixture.js";
import type { LiveSnapshot } from "../../src/venues/hyperliquid/live-reconcile.js";
import {
  parseLiveFill,
  parseLiveFunding,
} from "../../src/venues/hyperliquid/live-reconcile.js";
export const liveIdentity: LiveIdentity = {
  version: LIVE_VERSION,
  mode: "live",
  environment: "mainnet",
  owner_id: "operator",
  account_id: "live:h1",
  account_address: `0x${"1".repeat(40)}`,
  signer_address: `0x${"2".repeat(40)}`,
  signer_generation: "fixture-agent-v1",
  vault_address: null,
};
const account = jevIdentity("live");
export const liveScope = jevScope(
  account.bindings[0]!.binding,
  account.instrument,
);
export const venueFill = (
  now: number,
  delta: Record<string, unknown> = {},
) => ({
  coin: "BTC",
  px: "64000",
  sz: "0.0001",
  side: "B",
  time: now - 100,
  startPosition: "0",
  closedPnl: "0",
  hash: `0x${"a".repeat(64)}`,
  oid: 1,
  crossed: false,
  fee: "0.01",
  feeToken: "USDC",
  tid: 1,
  ...delta,
});
export const venueFunding = (
  now: number,
  delta: Record<string, unknown> = {},
) => ({
  time: now - 50,
  hash: `0x${"b".repeat(64)}`,
  delta: {
    type: "funding",
    coin: "BTC",
    usdc: "-0.001",
    szi: "0.0001",
    fundingRate: "0.000001",
    nSamples: 1,
  },
  ...delta,
});
export const venueState = (now: number, quantity = "0.0001") => ({
  time: now,
  marginSummary: { accountValue: "250", totalRawUsd: "250" },
  assetPositions: [
    {
      type: "oneWay",
      position: {
        coin: "BTC",
        szi: quantity,
        unrealizedPnl: "0",
        leverage: { type: "isolated", value: 1 },
      },
    },
  ],
});
export function liveSnapshot(
  now = Date.now(),
  changes: Partial<LiveSnapshot> = {},
): LiveSnapshot {
  const f = parseLiveFill(venueFill(now)),
    fund = parseLiveFunding(venueFunding(now));
  const s: LiveSnapshot = {
    version: LIVE_VERSION,
    identity_hash: jevHash(liveIdentity),
    snapshot_id: "",
    started_at: now,
    received_at: now,
    venue_at: now,
    position_raw: "10000",
    trading_balance_raw: "250000000",
    equity_raw: "250000000",
    open_pnl_raw: "0",
    isolated_1x: true,
    history_complete: true,
    consistent: true,
    flat: false,
    orders: [],
    fills: [f],
    funding: [fund],
    original: { fixture_only: true },
    ...changes,
  };
  s.snapshot_id = jevHash({ ...s, snapshot_id: "" });
  return s;
}
export function liveEntryCommand(
  now: number,
  operation_id = "entry:1",
): Extract<LiveCommand, { kind: "entry" }> {
  const manifest = initialJevManifest(1);
  const liveMetadata = parseHyperliquidBtcMetadata(
    {
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 40 },
      ],
      marginTables: [],
      collateralToken: 0,
    },
    new Date(now).toISOString(),
  );
  const plan = sizeJevEntry(
    manifest,
    liveMetadata,
    {
      scope: liveScope,
      order_id: operation_id,
      decision_id: "decision:fixture",
      decision_at: new Date(now).toISOString(),
      entry_price_raw: "64000000000",
      direction: "long",
      atr14_raw: "100000000",
      atr_captured_at: new Date(now - 1).toISOString(),
      maker_fee_rate9_raw: metadata.fees.maker.raw,
      exit_fee_rate9_raw: metadata.fees.taker.raw,
      funding_debit_rate9_raw: "0",
      cost_evidence_id: "cost:fixture",
    },
    "250000000",
  );
  return {
    version: LIVE_COMMAND_VERSION,
    kind: "entry",
    scope: liveScope,
    operation_id,
    metadata: liveMetadata,
    metadata_at: now,
    plan,
    manifest,
    snapshot: liveSnapshot(now, {
      position_raw: "0",
      flat: true,
      fills: [],
      funding: [],
    }),
    book: { bid_raw: "63999000000", ask_raw: "64001000000", received_at: now },
  };
}
