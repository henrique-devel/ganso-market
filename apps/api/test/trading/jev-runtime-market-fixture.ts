import type { DatabasePool } from "../../src/database.js";
import { decisionFixture } from "./jev-decision-fixture.js";
import { health, metadata } from "./bars-fixture.js";
import { scope } from "./risk-fixture.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
/** Artificial collector inputs for the actual worker. No operational evidence. */
export async function seedRuntimeMarket(
  pool: Pick<DatabasePool, "transaction">,
  at: number,
  initial = false,
) {
  const fixture = decisionFixture(at);
  await withBtcRetentionTransaction(pool, async (tx) => {
    const save = async (
      r: { object_id: string; payload: unknown; recorded_at: string },
      kind: string | null = null,
      bar = false,
    ) => {
      await storeRetentionObjectTx(tx, {
        id: r.object_id,
        class: "raw",
        identity: scope,
        recordedAt: new Date(r.recorded_at),
        payload: r.payload,
        dependencies: [],
      });
      if (kind)
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING",
          [r.object_id, kind, r.recorded_at],
        );
      if (bar) {
        const b = r.payload as { start_at: string; end_at: string };
        await tx.query(
          "INSERT INTO btc_market_bars(interval_ms,start_at,end_at,object_id) VALUES(900000,$1,$2,$3) ON CONFLICT DO NOTHING",
          [b.start_at, b.end_at, r.object_id],
        );
      }
    };
    if (initial) {
      for (const b of fixture.input.bars) await save(b, null, true);
      for (const d of fixture.input.dependencies)
        await save({ ...d, payload: { fixture: d.object_id } });
    }
    for (const r of [
      fixture.input.book!,
      fixture.input.mark_funding!,
      ...fixture.input.trades,
    ]) {
      const kind = r.payload.payload.kind;
      const payload =
        r.payload.payload.kind === "trade"
          ? {
              ...r.payload,
              key: `${r.payload.key}:${at}`,
              payload: {
                ...r.payload.payload,
                venue_trade_id: `${r.payload.payload.venue_trade_id}:${at}`,
              },
            }
          : r.payload;
      await save(
        { ...r, payload, object_id: `${r.object_id}:${at}` },
        kind === "book" ? "book" : kind === "trade" ? "trades" : "context",
      );
    }
    await save(
      {
        object_id: `meta:${at}`,
        recorded_at: new Date(at).toISOString(),
        payload: metadata,
      },
      "metadata",
    );
    const previous = (
      await tx.query<{ at: string }>(
        "SELECT o.payload->>'at' AS at FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' ORDER BY r.received_at DESC LIMIT 1",
      )
    ).rows[0]?.at;
    const from = initial ? at - 61000 : previous ? Number(previous) : at - 1000;
    // The synthetic collector runs continuously during boot/provider waits;
    // persist each bounded interval, without manufacturing an operational run.
    if (at - from > 120000 || at <= from)
      throw new Error("SYNTHETIC_CAPTURE_WINDOW");
    let index = 0;
    for (let start = from; start < at;) {
      const t = Math.min(at, start + 1000),
        h = health(t);
      for (const k of ["book", "context", "trades"] as const)
        h.channels[k] = {
          status: "healthy",
          last_received_at: t,
          last_source_at: t,
          source_quality: "fresh",
          gap_epoch: 0,
          needs_revalidation: false,
        };
      await save(
        {
          object_id: `capture:${at}:${index++}`,
          recorded_at: new Date(t).toISOString(),
          payload: { from: start, at: t, session: "fixture", health: h },
        },
        "capture",
      );
      start = t;
    }
  });
}
