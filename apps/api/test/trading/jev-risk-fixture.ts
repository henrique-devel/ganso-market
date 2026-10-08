import type { JevSizingInput } from "../../src/storage/jev-sizing.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { metadata } from "./bars-fixture.js";
import { jevIdentity, iso, start } from "./jev-v2-fixture.js";
const i = jevIdentity();
export const sizingInput: JevSizingInput = {
  scope: jevScope(i.bindings[0]!.binding, i.instrument),
  order_id: "entry",
  decision_id: "decision",
  decision_at: iso(start),
  entry_price_raw: "65000000000",
  direction: "long",
  atr14_raw: "200000000",
  atr_captured_at: iso(start - 1000),
  maker_fee_rate9_raw: metadata.fees.maker.raw,
  exit_fee_rate9_raw: metadata.fees.taker.raw,
  funding_debit_rate9_raw: "600000",
  cost_evidence_id: "fees-and-six-hour-funding",
};
