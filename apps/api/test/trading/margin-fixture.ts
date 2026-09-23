import type { DatabasePool } from "../../src/database.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { identity, iso } from "./ledger-fixture.js";
import { metadata } from "./bars-fixture.js";
/** Test-only observed metadata with the same stable instrument version. */
export function marginMetadata(at = Date.now()) {
  const copy = structuredClone(metadata);
  return {
    ...copy,
    instrument: {
      ...copy.instrument,
      origin: {
        ...copy.instrument.origin,
        received_at: iso(at),
        source_timestamp: iso(at),
      },
    },
  };
}
export async function seedMarginMetadata(
  pool: Pick<DatabasePool, "transaction">,
  at = Date.now(),
  payload = marginMetadata(at),
) {
  const id = `fixture:margin-metadata:${at}`;
  await withBtcRetentionTransaction(pool, async (tx) => {
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: ledgerScope(identity()),
      recordedAt: new Date(at),
      payload,
      dependencies: [],
    });
    await tx.query(
      "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,'metadata',$2,$2)",
      [id, iso(at)],
    );
  });
  return id;
}
