import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluationContext,
  validateEvaluationInput,
  type EvaluationInput,
} from "../../src/storage/evaluation.js";
import { allocatedCosts } from "../../src/trading/metrics.js";
import { pagedEvaluation } from "../../src/btc-metrics-cli.js";
import { sealReplayPages } from "../../src/storage/replay-pages.js";
import { windowFixture } from "./replay-pages-fixture.js";
const window = {
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-09-02T00:00:00.000Z",
};
const input = (): EvaluationInput => ({
  schema_version: "btc.evaluation-input.v1",
  allocation: {
    schema_version: "btc.cost-allocation.v1",
    window,
    complete: true,
    basis: "synthetic settled bill; equal allocation",
    bills: [
      {
        id: "opaque-1",
        kind: "infrastructure",
        total_usd_raw: "6000000",
        shares: [
          { account_id: "baseline", usd_raw: "3000000" },
          { account_id: "manual", usd_raw: "3000000" },
        ],
      },
    ],
  },
});
const ref = (): NonNullable<EvaluationInput["references"]>[number] => ({
  kind: "perpetual",
  exposure_bps: 2500,
  capital_usd_raw: "1000000000",
  window,
  prices: {
    start: {
      at: window.start,
      usd_raw: "50000000000",
      evidence_id: "synthetic-open",
    },
    end: {
      at: window.end,
      usd_raw: "60000000000",
      evidence_id: "synthetic-close",
    },
  },
  fees_usd_raw: "-1000000",
  funding_usd_raw: "-2000000",
  source: "synthetic_hyperliquid_btc",
  fee_basis: "synthetic signed fee",
  funding_basis: "synthetic full interval",
});
describe("private versioned evaluation input", () => {
  it("keeps invoice and perp unknown while cash is an explicit zero-return assumption", () => {
    const r = evaluationContext(undefined, { window }, "1000000000");
    expect(r.cost_status).toBe("unknown");
    expect(r.references[0]!.net_pnl_usd_raw).toBe("0");
    expect(r.references[1]!.net_pnl_usd_raw).toBeNull();
    expect(r.references[1]!.missing).toEqual([
      "endpoint_prices",
      "fees",
      "funding",
    ]);
    expect(evaluationContext(undefined, { window }, null).references).toEqual(
      [],
    );
  });
  it("conserves each bill once, fingerprints inputs and rejects duplicates or reservations disguised as fields", () => {
    const a = input();
    expect(validateEvaluationInput(a)).toEqual(a);
    expect(
      allocatedCosts(a.allocation, "baseline", window.start, window.end)
        .total_usd_raw,
    ).toBe("3000000");
    const h = evaluationContext(a, { window }, "1000000000").input_hash;
    expect(
      evaluationContext(structuredClone(a), { window }, "1000000000")
        .input_hash,
    ).toBe(h);
    a.allocation!.bills.push(a.allocation!.bills[0]!);
    expect(() => validateEvaluationInput(a)).toThrow("BILL_ID_OR_KIND");
    for (const bad of [
      null,
      [],
      { ...input(), schema_version: "future" },
      { ...input(), invoice: "private" },
      { ...input(), allocation: { ...input().allocation, complete: false } },
      { ...input(), allocation: { ...input().allocation, bills: null } },
    ])
      expect(() => validateEvaluationInput(bad)).toThrow();
    const b = input();
    b.allocation!.bills[0]!.shares[0]!.usd_raw = "2999999";
    expect(() => validateEvaluationInput(b)).toThrow("COST_CONSERVATION");
  });
  it("binds prices, fee/funding sources, capital and exact window without mixing spot", () => {
    const r = ref();
    const i: EvaluationInput = {
      schema_version: "btc.evaluation-input.v1",
      references: [r],
    };
    validateEvaluationInput(i);
    const result = evaluationContext(i, { window }, "1000000000");
    expect(result.references[0]!.net_pnl_usd_raw).toBe("47000000");
    expect(result.references).toHaveLength(2);
    expect(() => evaluationContext(i, { window }, "2000000000")).toThrow(
      "REFERENCE_WINDOW_OR_CAPITAL",
    );
    expect(() =>
      evaluationContext(
        i,
        { window: { ...window, end: "2026-09-03T00:00:00.000Z" } },
        "1000000000",
      ),
    ).toThrow("REFERENCE_WINDOW_OR_CAPITAL");
    r.funding_basis = null;
    expect(() => validateEvaluationInput(i)).toThrow("REFERENCE_SOURCE");
    r.funding_usd_raw = null;
    validateEvaluationInput(i);
    expect(
      evaluationContext(i, { window }, "1000000000").references[0]!
        .net_pnl_usd_raw,
    ).toBeNull();
    r.prices!.start.at = window.end;
    expect(() => validateEvaluationInput(i)).toThrow("REFERENCE_PRICE_TIME");
  });
});
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
it("offline report verifies all pages and applies costs once; corrupt or missing pages never yield a report", async () => {
  directory = await mkdtemp(join(tmpdir(), "ganso-evaluation-test-"));
  const b = sealReplayPages(windowFixture(12));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(b.artifact));
  for (const [i, page] of b.pages.entries())
    await writeFile(join(directory, `${i}.json`), JSON.stringify(page));
  const raw = await pagedEvaluation(directory);
  expect(raw.coverage.pages_verified).toBe(b.pages.length);
  expect(raw.after_operational_costs.net_pnl_usd_raw).toBeNull();
  const a = input();
  a.allocation!.window = raw.scope.window;
  a.allocation!.bills[0]!.shares = [
    { account_id: raw.scope.account_id, usd_raw: "6000000" },
  ];
  const r = await pagedEvaluation(directory, a);
  expect(r.after_operational_costs.net_pnl_usd_raw).toBe(
    (BigInt(r.trading.net_pnl_usd_raw!) - 6000000n).toString(),
  );
  expect(
    r.evaluation.references.every(
      (x) =>
        x.window.start === r.scope.window.start &&
        x.window.end === r.scope.window.end,
    ),
  ).toBe(true);
  await writeFile(
    join(directory, "0.json"),
    JSON.stringify({ ...b.pages[0], offset: 9 }),
  );
  await expect(pagedEvaluation(directory)).rejects.toThrow(
    "PAGE_SEQUENCE_OR_HASH",
  );
  await rm(join(directory, "0.json"));
  await expect(pagedEvaluation(directory)).rejects.toThrow();
});
