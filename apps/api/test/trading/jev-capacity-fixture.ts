import { parseTradingAmount } from "@ganso-market/contracts/trading";
import { buildJevContext } from "../../src/storage/jev-context.js";
import {
  makeJevEvidence,
  type JevEvidence,
  type JevEvidenceKind,
} from "../../src/storage/jev-evidence.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { contextFixture } from "./jev-context-fixture.js";
import { jevIdentity, iso } from "./jev-v2-fixture.js";
/** Delimited fixture: top5, 60 selected trades, 15 closed bars + their original dependencies,
 * independent paper/stress positions, holds, queue/partial/cancel, signed funding,
 * coverage, failure, cost, retired proposal and permanent results/version. No provider call. */
export function capacityFixture(horizon: 1 | 3 | 5, suffix: string) {
  const manifest = initialJevManifest(horizon),
    name = `h${horizon}`;
  const paper = jevIdentity("paper", name),
    stress = jevIdentity("stress", name);
  for (const i of [paper, stress]) {
    i.bindings[0]!.profile.horizon_minutes = horizon;
    i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
  }
  const scopes = [paper, stress].map((i) =>
    jevScope(i.bindings[0]!.binding, i.instrument),
  );
  const artifacts: JevEvidence[] = [];
  const contexts = [];
  const f = contextFixture();
  const book = f.input.book!.payload.payload;
  if (book.kind === "book") {
    const bids = Array.from({ length: 5 }, (_, i) => ({
      ...book.bids[0]!,
      price: parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: String(100000000 - i * 1000000),
      }),
    }));
    const asks = Array.from({ length: 5 }, (_, i) => ({
      ...book.asks[0]!,
      price: parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: String(102000000 + i * 1000000),
      }),
    }));
    f.input.book!.payload = {
      ...f.input.book!.payload,
      payload: { ...book, bids, asks },
    };
    f.input.book!.payload_hash = jevHash(f.input.book!.payload);
  }
  f.input.trades = Array.from({ length: 60 }, (_, i) =>
    f.record(
      `trade:${i}`,
      {
        ...f.input.trades[0]!.payload,
        key: `trade:${i}`,
        source_timestamp: iso(f.cut - i * 1000),
        received_at: iso(f.cut - i * 1000),
      },
      f.cut - i * 1000,
    ),
  );
  const originals = f.input.dependencies.map((ref, i) =>
    f.record(
      ref.object_id,
      { trade: f.input.trades[0]!.payload, bar_ordinal: i },
      Date.parse(ref.recorded_at),
    ),
  );
  f.input.dependencies = originals;
  for (const [index, identity] of [paper, stress].entries()) {
    const input = structuredClone(f.input),
      scope = scopes[index]!;
    input.account = f.record(`account:${scope.mode}`, {
      ...input.account.payload,
      scope,
      position: {
        position_id: `position:${scope.mode}`,
        direction: index ? "short" : "long",
        quantity_btc_raw: index ? "110000" : "120000",
        entry_price_raw: "101000000",
        stop_price_raw: index ? "109000000" : "93000000",
        first_fill_at: iso(f.cut - 5000),
      },
    });
    const context = buildJevContext(manifest, identity, input);
    contexts.push(context);
    const records = [
      input.account,
      input.book!,
      input.mark_funding!,
      ...input.trades,
      ...input.bars,
      ...originals,
      input.coverage!,
    ];
    const base = { scope, recorded_at: iso(f.cut), sources: [] };
    const id = (s: string) => `${suffix}:${scope.mode}:${s}`;
    artifacts.push(
      makeJevEvidence({
        ...base,
        object_id: id("inputs"),
        kind: "inputs",
        dependencies: [],
        payload: { records },
      }),
    );
    artifacts.push(
      makeJevEvidence({
        ...base,
        object_id: id("context"),
        kind: "context",
        dependencies: [id("inputs")],
        payload: { context, input_bundle_id: id("inputs") },
      }),
    );
  }
  const request = {
    model: "jev-1.13.0",
    state: {
      common: contexts[0],
      accounts: contexts.map((c) => ({ scope: c.scope, account: c.account })),
      fixture_only: true,
    },
    questions: Object.fromEntries(
      contexts.map((c) => [
        c.scope.account_id,
        {
          instructions: manifest.decision.instruction,
          horizon_minutes: horizon,
          scope: c.scope,
          choices: ["hold", "open_long", "open_short", "close"],
          criteria_version: manifest.decision.criteria_version,
        },
      ]),
    ),
  };
  const responseId = `${suffix}:response`,
    requestId = `${suffix}:request`;
  artifacts.push(
    makeJevEvidence({
      object_id: responseId,
      scope: scopes[0]!,
      kind: "response",
      recorded_at: iso(f.cut),
      sources: [],
      dependencies: [],
      payload: {
        request_id: requestId,
        model: request.model,
        outcome: "received",
        participants: scopes,
        original_body: JSON.stringify({
          fixture_only: true,
          choices: ["hold", "hold"],
          usage: { input_tokens: null },
          model: request.model,
        }),
      },
    }),
  );
  for (const scope of scopes) {
    const id = (s: string) => `${suffix}:${scope.mode}:${s}`,
      base = { scope, recorded_at: iso(f.cut), sources: [] };
    artifacts.push(
      makeJevEvidence({
        ...base,
        object_id: id("hold"),
        kind: "decision",
        dependencies: [id("context"), responseId],
        payload: {
          request_id: requestId,
          action: "hold",
          question: request.questions[scope.account_id]!,
          original_decision: { fixture_only: true, choice: "hold" },
          context_id: id("context"),
          response_id: responseId,
        },
      }),
    );
    for (const [kind, dep] of [
      ["order", "hold"],
      ["fill", "order"],
      ["funding", "fill"],
    ] as const)
      artifacts.push(
        makeJevEvidence({
          ...base,
          object_id: id(kind),
          kind,
          dependencies: [id(dep)],
          payload: {
            artifact_id: id(kind),
            original: {
              fixture_only: true,
              scope,
              order_id: id("order"),
              received_at: iso(f.cut),
              queue_ahead_btc_raw: "12000000",
              partial_btc_raw: "120000",
              cancel_reconciled: true,
              funding_usd_raw: "-1000",
              fee_usd_raw: "12000",
            },
          },
        }),
      );
    artifacts.push(
      makeJevEvidence({
        ...base,
        object_id: id("quality"),
        kind: "quality",
        dependencies: [id("context")],
        payload: {
          start_at: iso(f.cut - 60000),
          end_at: iso(f.cut),
          gaps: [],
          counters: {
            fixture_only: true,
            expected_samples: 60,
            observed_samples: 60,
            measured_internal_gaps: false,
          },
        },
      }),
    );
    for (const kind of ["ledger", "result", "version"] as JevEvidenceKind[])
      artifacts.push(
        makeJevEvidence({
          ...base,
          object_id: id(kind),
          kind,
          dependencies: [],
          payload: {
            artifact_id: id(kind),
            original: {
              fixture_only: true,
              scope,
              manifest_hash: jevHash(manifest),
              equity_usd_raw: "249999000",
              evaluation: "unqualified",
            },
          },
        }),
      );
  }
  for (const kind of ["proposal", "cost"] as const)
    artifacts.push(
      makeJevEvidence({
        object_id: `${suffix}:${kind}`,
        scope: scopes[0]!,
        kind,
        recorded_at: iso(f.cut),
        dependencies: [],
        sources: [],
        payload: {
          artifact_id: `${suffix}:${kind}`,
          original: {
            fixture_only: true,
            request_id: requestId,
            actual_cost_usd_raw: null,
            retired_proposal: true,
            manifest,
          },
        },
      }),
    );
  artifacts.push(
    makeJevEvidence({
      object_id: `${suffix}:failure`,
      scope: scopes[0]!,
      kind: "response",
      recorded_at: iso(f.cut),
      dependencies: [],
      sources: [],
      payload: {
        request_id: `${requestId}:failed`,
        model: request.model,
        outcome: "timeout",
        original_body: null,
      },
    }),
  );
  return { paper, stress, manifest, artifacts, request };
}
