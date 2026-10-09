import type { DatabasePool } from "../database.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { jevHash } from "./jev-hash.js";
export class JevPanelCommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function validateInfrastructure(
  input: unknown,
  key: unknown,
): { month: string; usd6: string } {
  const b = input as { month?: unknown; usd6?: unknown } | null;
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(key) ||
    !b ||
    Array.isArray(b) ||
    Object.keys(b).sort().join() !== "month,usd6" ||
    typeof b.month !== "string" ||
    !/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(b.month) ||
    typeof b.usd6 !== "string" ||
    !/^(0|[1-9][0-9]{0,17})$/.test(b.usd6)
  )
    throw new JevPanelCommandError(400, "JEV_PANEL_INVALID_COMMAND");
  return { month: b.month, usd6: b.usd6 };
}
export async function recordJevInfrastructure(
  pool: Pick<DatabasePool, "transaction">,
  owner: string,
  input: unknown,
  key: string,
) {
  const request = validateInfrastructure(input, key);
  return withBtcRetentionTransaction(pool, async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,741060))",
      [owner],
    );
    const old = (
      await tx.query<{ request: unknown; sequence: string }>(
        "SELECT request,sequence::text FROM jev_infrastructure_events WHERE owner_id=$1 AND idempotency_key=$2",
        [owner, key],
      )
    ).rows[0];
    if (old) {
      if (jevHash(old.request) !== jevHash(request))
        throw new JevPanelCommandError(409, "JEV_PANEL_IDEMPOTENCY_COLLISION");
      return { status: "duplicate", sequence: old.sequence, ...request };
    }
    const row = (
      await tx.query<{ sequence: string }>(
        "INSERT INTO jev_infrastructure_events(owner_id,idempotency_key,month,usd6,request) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING sequence::text",
        [owner, key, request.month, request.usd6, JSON.stringify(request)],
      )
    ).rows[0]!;
    return { status: "recorded", sequence: row.sequence, ...request };
  });
}
