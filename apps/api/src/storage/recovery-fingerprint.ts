import type { Hash } from "node:crypto";
import type { SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";

// Only canonical serialization is memoized, never account readiness or a digest
// of current state. PG re-reads, sorts and hashes EVERY authoritative row on EVERY
// boundary, including historical rows. A changed row must return its full value.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const cache = new Map<string, { table: string; text: string; bytes: number }>();
let bytes = 0;

/** Preserve the byte-for-byte v1 checkpoint format and SQL ordering. This cache
 * is disposable across restarts; a cold process performs the original full read.
 * table comes only from recovery-audit's closed table list. */
export async function fingerprintRecoveryTable(
  tx: SqlExecutor,
  table: string,
  account: string,
  hash: Hash,
): Promise<number> {
  if (!/^btc_[a-z_]+$/.test(table)) throw new Error("BTC_RECOVERY_TABLE");
  // Keep strong references for this statement: another account can evict shared
  // entries while its query is in flight, without invalidating this result.
  const known = new Map(
    [...cache].filter(([, entry]) => entry.table === table),
  );
  const { rows } = await tx.query<{ fingerprint: string; value: unknown }>(
    `SELECT fingerprint, CASE WHEN fingerprint=ANY($2::text[]) THEN NULL ELSE value END AS value
     FROM (SELECT value, encode(sha256(convert_to(value::text,'UTF8')),'hex') AS fingerprint
       FROM (SELECT to_jsonb(t) AS value FROM ${table} t WHERE account_id=$1) source) hashed
     ORDER BY hashed.value::text`,
    [account, [...known.keys()]],
  );
  hash.update(`[${JSON.stringify(table)},[`);
  for (const [index, row] of rows.entries()) {
    let entry = known.get(row.fingerprint);
    if (row.value !== null) {
      const text = canonicalFingerprint({ value: row.value });
      entry = { table, text, bytes: Buffer.byteLength(text) };
      if (entry.bytes <= MAX_BYTES && !cache.has(row.fingerprint)) {
        while (cache.size >= MAX_ENTRIES || bytes + entry.bytes > MAX_BYTES) {
          const oldest = cache.keys().next().value!;
          bytes -= cache.get(oldest)!.bytes;
          cache.delete(oldest);
        }
        cache.set(row.fingerprint, entry);
        bytes += entry.bytes;
      }
    }
    if (!entry) throw new Error("BTC_RECOVERY_FINGERPRINT_MISSING");
    if (index) hash.update(",");
    hash.update(entry.text);
  }
  hash.update("]]");
  return rows.length;
}
